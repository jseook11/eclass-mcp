# API-First Materials And Separate Video Downloads

## Summary
- Convert high-priority read paths to API-first while keeping Playwright fallbacks.
- Keep existing file download tools file-only.
- Add a separate video download feature for verified OCS UniPlayer MP4 content.
- Update [docs/TOOLS.md](TOOLS.md) whenever tool behavior or schemas change.

## Key Changes
- Add LearningX HTTP/API support:
  - Use Canvas `sessionless_launch` for CourseResource.
  - POST the returned LTI form over HTTP.
  - Extract `xn_api_token` from response cookies without logging secrets.
  - Fetch `resources_db` with the LearningX token.
  - Fall back to existing Playwright intercept if API launch or fetch fails.
- Add external tool ID recovery:
  - Default CourseResource tool ID remains `3`.
  - On launch failure, query Canvas tabs / launch definitions and match CourseResource by known labels such as `강의자료실` plus stable name/description hints.
- Improve `eclass_get_assignments`:
  - With `course_id`, use `/api/v1/courses/:course_id/assignments?include[]=submission&per_page=100`.
  - Return optional `assignment_id`, `submission_types`, `allowed_extensions`, and `allowed_attempts`.
  - Keep planner behavior for all-course deadline queries.
- Split file vs video downloading:
  - Existing `eclass_download_file` and `eclass_download_materials_batch` stay for non-video files.
  - Video-like types (`mp4`, `video/*`, `hls`, `m3u8`, etc.) return a clear error pointing to the video tool.
  - Add `eclass_download_video` with OCS UniPlayer MP4 support only.
  - Do not support HLS, DRM, encrypted media, or progress/attendance event bypass.

## Public Interfaces
- `eclass_get_materials` remains compatible, but video materials should be identifiable by `type` and URL.
- `eclass_get_assignments` gains optional fields:
  - `assignment_id`
  - `submission_types`
  - `allowed_extensions`
  - `allowed_attempts`
- New tool: `eclass_download_video`
  - Input: `{ video_id: string, course_id: number, url: string, display_name: string, type?: string, source?: string }`
  - Supports only `https://ocs.cau.ac.kr/em/<content_id>` UniPlayer URLs.
  - Output mirrors file downloads: `{ video_id, display_name, local_path, size_bytes, skipped, strategy: 'ocs_uniplayer_mp4' }`.

## Video Implementation
- Extract OCS content ID from the viewer URL.
- Fetch `https://ocs.cau.ac.kr/viewer/ssplayer/uniplayer_support/content.php?content_id=<id>`.
- Parse XML metadata for `main_media`.
- Build the CDN MP4 candidate from the discovered content ID and media filename.
- Verify with `HEAD` or `Range: bytes=0-15`:
  - HTTPS only.
  - `content-type` is `video/mp4`.
  - MP4 signature is present.
  - No credentials sent to CDN.
- Save under `ECLASS_DOWNLOAD_DIR/{course_id}/` and record in cache with `source`.

## Test Plan
- Mocked tests for CourseResource API-first success, token-cookie extraction, secret redaction, and Playwright fallback.
- Mocked tests for dynamic tool ID recovery.
- `getAssignments` tests for course assignments API path and planner fallback path.
- Download strategy tests proving video types no longer route through file download.
- `eclass_download_video` tests for OCS URL parsing, XML parsing, MP4 signature validation, CDN credential isolation, cache hit, and unsupported HLS/DRM failure.
- Run `pnpm test` and `pnpm build`.

## Documentation
- Update [docs/TOOLS.md](TOOLS.md):
  - Document API-first CourseResource behavior.
  - Document new assignment fields.
  - Mark file download tools as file-only.
  - Add `eclass_download_video` usage, supported OCS MP4 limits, and unsupported video cases.
