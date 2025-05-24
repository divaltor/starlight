from __future__ import annotations

import json
import logging
import re
from abc import ABC
from collections.abc import AsyncGenerator
from json import JSONDecodeError
from typing import Annotated, Any, ClassVar, TypeVar

import httpx
from fake_useragent import UserAgent
from httpx import codes
from jsonpath_ng.ext import parse
from pydantic import AfterValidator, ValidationError, validate_call

from app.services.models.base import BaseModel
from app.services.models.post import TwitterPost
from app.services.models.user import TwitterUser
from app.utils import find_key_recursive

logger = logging.getLogger(__name__)

# Search values here - https://x.com
DEFAULT_KWARGS = {
    'articles_preview_enabled': False,
    'c9s_tweet_anatomy_moderator_badge_enabled': True,
    'communities_web_enable_tweet_community_results_fetch': True,
    'creator_subscriptions_quote_tweet_preview_enabled': False,
    'creator_subscriptions_tweet_preview_api_enabled': True,
    'freedom_of_speech_not_reach_fetch_enabled': True,
    'graphql_is_translatable_rweb_tweet_is_translatable_enabled': True,
    'longform_notetweets_consumption_enabled': True,
    'longform_notetweets_inline_media_enabled': True,
    'longform_notetweets_rich_text_read_enabled': True,
    'responsive_web_edit_tweet_api_enabled': True,
    'responsive_web_enhance_cards_enabled': False,
    'responsive_web_graphql_exclude_directive_enabled': True,
    'responsive_web_graphql_skip_user_profile_image_extensions_enabled': False,
    'responsive_web_graphql_timeline_navigation_enabled': True,
    'responsive_web_media_download_video_enabled': False,
    'responsive_web_twitter_article_tweet_consumption_enabled': True,
    'rweb_tipjar_consumption_enabled': True,
    'rweb_video_timestamps_enabled': True,
    'standardized_nudges_misinfo': True,
    'tweet_awards_web_tipping_enabled': False,
    'tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled': True,
    'tweet_with_visibility_results_prefer_gql_media_interstitial_enabled': False,
    'tweetypie_unmention_optimization_enabled': True,
    'verified_phone_label_enabled': False,
    'view_counts_everywhere_api_enabled': True,
    'responsive_web_grok_analyze_button_fetch_trends_enabled': False,
    'premium_content_api_read_enabled': False,
    'profile_label_improvements_pcf_label_in_post_enabled': False,
    'responsive_web_grok_share_attachment_enabled': False,
    'responsive_web_grok_analyze_post_followups_enabled': False,
    'responsive_web_grok_image_annotation_enabled': False,
    'responsive_web_grok_analysis_button_from_backend': False,
    'responsive_web_jetfuel_frame': False,
    'rweb_video_screen_enabled': True,
    'responsive_web_grok_show_grok_translated_post': True,
}


type UserID = int | str

ENTRIES_ONLY = parse('$..entries[?(@.entryId =~ "^(?!(cursor-|messageprompt-))")]')
CURSOR_BOTTOM = parse('$..entries[?(@.entryId =~ "^(cursor-bottom)")]')


def encode_params(data: dict[str, Any]) -> dict[str, str]:
    result = {}

    for key, value in data.items():
        if isinstance(value, dict):
            encoded_value = json.dumps(
                {a: b for a, b in value.items() if b is not None},
                separators=(',', ':'),
            )
            result[key] = str(encoded_value)

    return result


class TwitterAPIError(IOError):
    def __init__(self, status_code: int, reason: str) -> None:
        super().__init__(status_code, reason)

        self.status_code = status_code
        self.reason = reason

    @classmethod
    def from_response(cls, response: httpx.Response) -> TwitterAPIError:
        return cls(response.status_code, response.text)

    def __str__(self) -> str:
        return f'Unexpected error from Twitter API: {self.status_code} {self.reason}'


class TwitterAPI:
    def __init__(
        self,
        cookies: dict[str, str],
        base_url: str = 'https://x.com/i/api/graphql/',
        user_agent: str | None = None,
    ):
        self.client = httpx.AsyncClient(
            base_url=base_url,
            cookies=cookies,
            headers={
                'User-Agent': user_agent or UserAgent().chrome,
                'x-twitter-client-language': 'en',
                'x-twitter-active-user': 'yes',
                'Authorization': 'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA',
                'x-csrf-token': cookies['ct0'],
                'x-twitter-auth-type': 'OAuth2Session',
            },
        )

    @staticmethod
    def _prepare_params(
        data: dict[str, Any] | None = None,
        features: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        features_payload = {**DEFAULT_KWARGS}

        if features:
            features_payload.update(features)

        return {'variables': data or {}, 'features': features_payload}

    async def list_graphql_request(
        self,
        url: str,
        data: dict[str, Any] | None = None,
        features: dict[str, Any] | None = None,
    ) -> AsyncGenerator[list[dict[str, Any]]]:
        params = self._prepare_params(data, features)

        cursor = None

        if cursor is not None:
            params['variables']['cursor'] = cursor

        response = await self.client.get(url, params=encode_params(params))

        if not response.is_success:
            logger.error('Twitter API error: %s', response.text)
            raise TwitterAPIError.from_response(response)

        try:
            json_response = response.json()
        except JSONDecodeError as ex:
            raise TwitterAPIError.from_response(response) from ex

        logger.debug('JSON response: %s', json.dumps(json_response))

        entries = find_key_recursive(json_response, 'entries')

        filtered_entries = [
            entry
            for entry in entries
            if entry.get('entryId') is not None
            and not entry.get('entryId').startswith(('cursor-', 'messageprompt-'))
        ]

        logger.debug('Filtered entries: %s', filtered_entries)

        if filtered_entries:
            yield filtered_entries

        # If no entries - we at the end of query, no need to continue
        else:
            return

        cursor_entry = find_key_recursive(json_response, 'entryId', 'cursor-bottom')

        # If no cursor - we at the end of query
        if not cursor_entry:
            return

        cursor = cursor_entry['content']['itemContent']['value']

    async def get_graphql_request(
        self,
        url: str,
        data: dict[str, Any] | None = None,
        features: dict[str, Any] | None = None,
    ) -> dict[str, Any] | None:
        params = self._prepare_params(data, features)

        response = await self.client.get(url, params=encode_params(params))

        if response.status_code == codes.NOT_FOUND:
            return None

        if not response.is_success:
            raise TwitterAPIError.from_response(response)

        try:
            json_response = response.json()
        except JSONDecodeError as ex:
            raise TwitterAPIError.from_response(response) from ex

        logger.debug('JSON response: %s', json.dumps(json_response))

        return json_response

    @property
    def users(self) -> Users:
        return Users(self)

    @property
    def likes(self) -> Likes:
        return Likes(self)

    @property
    def posts(self) -> Posts:
        return Posts(self)


def extract_post_id(x: str) -> str:
    match = re.match(r'^https://x\.com/(.*)/status/(\d+)(\?s=.*)?$', x)

    if match is None:
        raise ValueError('Invalid post ID')

    return match.group(2)


T = TypeVar('T', bound=BaseModel)
type PostID = Annotated[str, AfterValidator(extract_post_id)]


class BaseEndpoint[T: BaseModel](ABC):
    OPERATOR: ClassVar[str]
    MODEL: type[T]

    FEATURES: ClassVar[dict[str, Any]] = {}
    VARIABLES: ClassVar[dict[str, Any]] = {}

    def __init__(self, api: TwitterAPI) -> None:
        self.api = api

    async def _list_request(
        self,
        data: dict[str, Any] | None = None,
    ) -> AsyncGenerator[list[dict[str, Any]]]:
        async for entries in self.api.list_graphql_request(
            self.OPERATOR,
            data={**self.VARIABLES, **(data or {})},
            features=self.FEATURES,
        ):
            yield entries

    async def _single_request(
        self,
        data: dict[str, Any] | None = None,
    ) -> dict[str, Any] | None:
        return await self.api.get_graphql_request(
            self.OPERATOR,
            data={**self.VARIABLES, **(data or {})},
            features=self.FEATURES,
        )

    def _serialize(self, data: Any) -> T:
        return self.MODEL.from_twitter_response(data)


class Users(BaseEndpoint[TwitterUser]):
    OPERATOR = '1VOOyvKkiI3FMmkeDNxM9A/UserByScreenName'

    MODEL = TwitterUser

    FEATURES = {
        'highlights_tweets_tab_ui_enabled': True,
        'hidden_profile_likes_enabled': True,
        'creator_subscriptions_tweet_preview_api_enabled': True,
        'hidden_profile_subscriptions_enabled': True,
        'subscriptions_verification_info_verified_since_enabled': True,
        'subscriptions_verification_info_is_identity_verified_enabled': False,
        'responsive_web_twitter_article_notes_tab_enabled': False,
        'subscriptions_feature_can_gift_premium': False,
        'profile_label_improvements_pcf_label_in_post_enabled': False,
    }

    async def get(self, username: str) -> TwitterUser | None:
        return self._serialize(
            await self._single_request(
                data={'screen_name': username, 'withSafetyModeUserFields': True},
            ),
        )


class Posts(BaseEndpoint[TwitterPost]):
    OPERATOR = '_8aYOgEDz35BrBcBal1-_w/TweetDetail'

    MODEL = TwitterPost

    VARIABLES = {
        'with_rux_injections': True,
        'includePromotedContent': True,
        'withCommunity': True,
        'withQuickPromoteEligibilityTweetFields': True,
        'withBirdwatchNotes': True,
        'withVoice': True,
        'withV2Timeline': True,
    }

    @validate_call
    async def get(self, post_id: PostID) -> TwitterPost | None:
        data = {'focalTweetId': str(post_id)}

        try:
            return self._serialize(await self._single_request(data=data))
        except ValidationError:
            logger.exception('Twitter API error')
            return None


class Likes(BaseEndpoint[TwitterPost]):
    OPERATOR = 'XHTMjDbiTGLQ9cP1em-aqQ/Likes'

    MODEL = TwitterPost

    VARIABLES = {
        'includePromotedContent': False,
        'withClientEventToken': False,
        'withBirdwatchNotes': False,
        'withVoice': True,
    }

    @validate_call
    async def list(
        self,
        user_id: UserID,
        count: int | None = None,
    ) -> AsyncGenerator[list[TwitterPost]]:
        data = {
            'userId': str(user_id),
            'count': count or 20,
        }

        async for entries in self._list_request(data=data):
            yield [self._serialize(entry) for entry in entries]
