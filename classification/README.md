# Classification API

## /classify Endpoint
Accepts JSON body: {"image": "<base64|data URI|http(s) URL>"}

Examples:

Base64 (raw):
{
  "image": "iVBORw0KGgoAAA..."
}

Data URI:
{
  "image": "data:image/png;base64,iVBORw0KGgoAAA..."
}

Remote URL:
{
  "image": "https://example.com/image.png"
}

Query parameter `model` must be one of: nsfw, aesthetic, tags.

Returns a list of classification results specific to the model chosen.

Errors:
- 400 Invalid model / invalid base64 / not an image URL / download failure
- 500 Inference failure or dependency import issue
