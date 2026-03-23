# Pinata Upload App

Simple imgbb-style upload website that stores files on Pinata and returns shareable links.

## Features

- Fast single-file upload UI
- Clipboard paste support for copied images
- Server-side Pinata upload using JWT
- Automatic Pinata public group creation and reuse
- Short share link plus direct open, direct file, and download links
- Image preview after upload

## Setup

1. Check `.env` and update values if needed.
2. Run `npm install`
3. Run `npm start`
4. Open `http://localhost:3000`

## Environment

- `PINATA_JWT`: Your Pinata JWT
- `PINATA_GROUP_NAME`: Public group name where files will be organized
- `PINATA_GATEWAY_HOST`: Optional custom gateway host
- `PORT`: Local server port

## Notes

- Max upload size is 25MB in the current app.
- Files are uploaded to Pinata `public` network.
- Grouping is handled with Pinata public groups instead of a local folder structure.
- Short links are stored locally in `data/short-links.json`.
