from __future__ import annotations

import json
import logging
from abc import ABC
from json import JSONDecodeError
from typing import TYPE_CHECKING, Any, ClassVar, cast

import httpx
from fake_useragent import UserAgent
from httpx import codes
from jsonpath_ng.ext import parse

if TYPE_CHECKING:
    from collections.abc import AsyncGenerator


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

ENTRIES_ONLY = parse('$..entries[?(@.entryId =~ "^(?!(cursor-|messageprompt-))")]')
CURSOR_BOTTOM = parse('$..entries[?(@.entryId =~ "^(cursor-bottom)")]')

type UserID = int | str


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

    async def list_graphql_request(
        self,
        url: str,
        data: dict[str, Any] | None = None,
        features: dict[str, Any] | None = None,
        limit: int | None = None,
    ) -> AsyncGenerator[list[dict[str, Any]]]:
        variables_payload = data or {}

        features_payload = {**DEFAULT_KWARGS}

        if features:
            features_payload.update(features)

        params = {'variables': variables_payload, 'features': features_payload}

        cursor = None
        count = 0

        while True:
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

            entries = cast('list[dict[str, Any]]', ENTRIES_ONLY.find(json_response))

            if entries:
                yield entries
            # If no entries - we at the end of query, no need to continue
            else:
                return

            cursor_entry = cast('list[dict[str, Any]]', CURSOR_BOTTOM.find(json_response))

            # If no cursor - we at the end of query
            if not cursor_entry:
                return

            cursor = cursor_entry[0]['content']['value']

            # Check limit, if reached - return
            if limit is not None:
                count += len(entries)

                if count >= limit:
                    return

    async def get_graphql_request(
        self,
        url: str,
        data: dict[str, Any] | None = None,
        features: dict[str, Any] | None = None,
    ) -> dict[str, Any] | None:
        variables_payload = data or {}

        features_payload = {**DEFAULT_KWARGS}

        if features:
            features_payload.update(features)

        params = {'variables': variables_payload, 'features': features_payload}

        response = await self.client.get(url, params=encode_params(params))

        if response.status_code == codes.NOT_FOUND:
            return None

        if not response.is_success:
            raise TwitterAPIError.from_response(response)

        try:
            return response.json()
        except JSONDecodeError as ex:
            raise TwitterAPIError.from_response(response) from ex

    @property
    def users(self) -> Users:
        return Users(self)

    @property
    def likes(self) -> Likes:
        return Likes(self)

    @property
    def posts(self) -> Posts:
        return Posts(self)


class BaseEndpoint(ABC):
    OPERATOR: ClassVar[str]

    FEATURES: ClassVar[dict[str, Any]] = {}

    def __init__(self, api: TwitterAPI) -> None:
        self.api = api

    async def _list_request(
        self,
        data: dict[str, Any] | None = None,
        limit: int | None = None,
    ) -> AsyncGenerator[list[dict[str, Any]]]:
        async for entries in self.api.list_graphql_request(
            self.OPERATOR,
            data=data,
            features=self.FEATURES,
            limit=limit,
        ):
            yield entries

    async def _single_request(
        self,
        data: dict[str, Any] | None = None,
    ) -> dict[str, Any] | None:
        return await self.api.get_graphql_request(
            self.OPERATOR,
            data=data,
            features=self.FEATURES,
        )


class Users(BaseEndpoint):
    OPERATOR = '1VOOyvKkiI3FMmkeDNxM9A/UserByScreenName'

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

    async def get(self, username: str) -> dict[str, Any] | None:
        return await self._single_request(
            data={'screen_name': username, 'withSafetyModeUserFields': True},
        )


class Posts(BaseEndpoint):
    OPERATOR = '_8aYOgEDz35BrBcBal1-_w/TweetDetail'

    async def get(self, post_id: str) -> dict[str, Any] | None:
        data = {
            'focalTweetId': str(post_id),
            'with_rux_injections': True,
            'includePromotedContent': True,
            'withCommunity': True,
            'withQuickPromoteEligibilityTweetFields': True,
            'withBirdwatchNotes': True,
            'withVoice': True,
            'withV2Timeline': True,
        }

        return await self._single_request(data=data)


class Likes(BaseEndpoint):
    OPERATOR = 'rbRmoDY1Z10wXwd1UyOIFw/Likes'

    FEATURES = {
        'includePromotedContent': False,
        'withClientEventToken': False,
        'withBirdwatchNotes': False,
        'withVoice': True,
    }

    async def list(
        self,
        user_id: UserID,
        count: int | None = None,
        limit: int | None = None,
    ) -> AsyncGenerator[list[dict[str, Any]]]:
        data = {
            'userId': str(user_id),
            'count': count or 20,
            **self.FEATURES,
        }

        async for entries in self._list_request(data=data, limit=limit):
            yield entries
