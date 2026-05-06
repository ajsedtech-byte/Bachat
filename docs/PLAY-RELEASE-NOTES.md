# Google Play Release Notes

If Google Play Console shows errors like "You need to upload an APK or Android App Bundle for this app" or "This release does not add or remove any app bundles", the draft release does not currently contain a usable new bundle.

## What Play expects

- Upload a new `.aab` file to the release draft.
- The uploaded bundle must use a `versionCode` higher than every bundle previously uploaded for this app.
- Existing users must be able to upgrade from the currently installed version to the new one.

## Project versioning

The Android app now reads version values from Gradle properties in `android/app/build.gradle`:

- `BACHAT_VERSION_CODE`
- `BACHAT_VERSION_NAME`

Default values:

- `versionCode = 2`
- `versionName = 1.0.1`

If Play Console has already seen `2`, use the next unused integer such as `3`, `4`, or `5`.

## Build a new Android App Bundle

From the repo root:

```powershell
cd android
.\gradlew.bat bundleRelease -PBACHAT_VERSION_CODE=2 -PBACHAT_VERSION_NAME=1.0.1
```

The bundle is typically generated at:

```text
android\app\build\outputs\bundle\release\app-release.aab
```

## In Play Console

1. Open the release draft.
2. Go back to the upload step if the release currently has no bundle attached.
3. Upload the new `.aab`.
4. Confirm Play shows the new version code.
5. Save, review, and roll out again.
