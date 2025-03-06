import uuid
from pathlib import Path

import yt_dlp


def download_video(url: str, folder: str) -> Path:
    random_id = str(uuid.uuid4())

    with yt_dlp.YoutubeDL(
        {
            'outtmpl': f'{folder}/{random_id}.mp4',
            'quiet': True,
            'no_warnings': True,
            'no_post_overwrites': True,
            'no_overwrites': True,
            'recode-video': 'mp4',
        },
    ) as ydl:
        ydl.download([url])

    return Path(folder, f'{random_id}.mp4')
