# Pinata Upload App

image upload website that stores files on Pinata and returns shareable short links

## Features

- Fast single file upload UI
- Clipboard paste support for copied images
- Server side Pinata upload using JWT
- Short share link plus direct open, direct file and download links
- Image preview after upload

## Setup

- Check `.env` and update values if needed

## Environment

- `PINATA_JWT`: Your Pinata JWT
- `FIREBASE_PROJECT_ID`: Firebase project ID
- `FIREBASE_CLIENT_EMAIL`: Firebase service account client email
- `FIREBASE_PRIVATE_KEY`: Firebase service account private key
## Notes

- Max upload size is 25MB in the current app.
- Files are uploaded to Pinata `public` network.
- Hidden short links require Firebase Firestore plus a service account.
