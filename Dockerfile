FROM python:3.12-bookworm

ENV PYTHONPATH "${PYTHONPATH}:/code"
ENV PATH "/code:${PATH}"
ENV POETRY_VERSION 1.7.1

WORKDIR /code

COPY --from=linuxserver/ffmpeg /usr/local/bin/ffprobe /usr/bin/ffprobe
COPY --from=linuxserver/ffmpeg /usr/local/bin/ffmpeg /usr/bin/ffmpeg

RUN pip install --no-cache-dir poetry=="$POETRY_VERSION" && pip install --pre yt-dlp

COPY poetry.lock pyproject.toml /code/

RUN poetry config virtualenvs.create false && poetry install --no-interaction --no-ansi --no-root --without dev

COPY . /code/

CMD ["python", "app/main.py"]
