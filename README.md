# Comfyui-Image-Stitch

**Multi Stitch Images** for ComfyUI — paste many images directly into one node, crop each image non-destructively, reorder them, and stitch the result with the familiar `Stitch Images` controls.

> 한국어 설명은 바로 아래에 있습니다. English documentation follows.

![Multi Stitch Images example](docs/example-node.svg)

## 🇰🇷 한국어

### 핵심 기능

- **Ctrl+V 다중 이미지 붙여넣기**: `Multi Stitch Images` 노드를 선택한 상태에서 이미지를 붙여넣으면 노드 내부에 순서대로 추가됩니다.
- **이미지 개수 제한 없이 실사용 중심**: 백엔드 안전 제한은 256장입니다.
- **개별 Crop 편집기**: 썸네일을 클릭하면 Microsoft Photos 스타일의 간단한 Crop UI가 열립니다.
- **비파괴 Crop**: 원본 파일을 다시 저장하지 않고, workflow에는 정규화된 Crop 좌표만 저장합니다.
- **순서 변경 / 삭제**: 각 썸네일의 `‹` `›` 버튼으로 순서를 바꾸고 `×`로 제거합니다.
- **드래그 앤 드롭 / Add images…** 지원.
- **Stitch Images와 동일한 핵심 옵션**:
  - `direction`: `right / down / left / up`
  - `match_image_size`
  - `spacing_width`
  - `spacing_color`: `white / black / red / green / blue`
- 노드 안에서 **예상 최종 해상도**를 바로 표시합니다.
- 출력은 일반 `IMAGE`이므로 **Preview Image / Save Image / VAE Encode** 등에 바로 연결할 수 있습니다.

### Crop 편집기

![Crop editor example](docs/crop-editor.svg)

Crop 창에서 다음을 지원합니다.

- Crop 박스 내부 드래그 → 위치 이동
- 네 모서리 드래그 → 크기 조절
- Crop 박스 밖에서 드래그 → 새 Crop 영역 지정
- 비율 프리셋: `Free / Original / 1:1 / 4:3 / 3:2 / 16:9 / 9:16`
- `Reset` → 원본 전체 영역으로 복구
- `Apply crop` → Crop 좌표만 workflow에 저장

### 설치

ComfyUI의 `custom_nodes` 폴더에서:

```bash
git clone https://github.com/ssain3d-lgtm/Comfyui-Image-Stitch.git
```

그 다음 ComfyUI를 재시작합니다. 추가 Python 패키지는 필요하지 않습니다.

### 사용법

1. 노드 검색에서 **`Multi Stitch Images`** 를 추가합니다. 카테고리는 `image/transform` 입니다.
2. **Multi Stitch Images 노드를 한 번 클릭해서 선택**합니다.
3. Windows 탐색기, 브라우저, 이미지 편집기 등에서 이미지를 복사한 뒤 **Ctrl+V** 합니다.
   - 클립보드가 여러 이미지 파일을 제공하면 한 번에 모두 추가합니다.
   - 스크린샷 클립보드는 보통 1장씩 추가됩니다.
4. 노드 내부 썸네일을 클릭해서 필요한 이미지만 Crop 합니다.
5. `‹ / ›`로 순서를 정리합니다.
6. `direction`, `match_image_size`, `spacing_width`, `spacing_color`를 설정합니다.
7. `IMAGE` 출력을 **Preview Image**에 연결합니다.
8. Queue를 실행하면 서버에서 원본 이미지를 읽고 Crop → 크기 매칭 → Stitch 순서로 처리합니다.

### 붙여넣기 동작 방식

최신 ComfyUI 프론트엔드는 선택된 이미지 노드에 대해 `pasteFiles()`를 호출할 수 있습니다. 이 노드는 `previewMediaType = "image"`와 `pasteFiles()`를 제공해서 **ComfyUI 자체 Ctrl+V 라우팅을 그대로 사용**합니다. 별도의 전역 Ctrl+V 가로채기를 최소화해서 다른 노드의 복사/붙여넣기 동작과 충돌할 가능성을 줄였습니다.

붙여넣거나 추가한 이미지는 다음 폴더에 저장됩니다.

```text
ComfyUI/input/multi_stitch/
```

Workflow에는 파일 경로와 Crop 좌표가 저장됩니다. 따라서 다른 PC로 workflow만 이동할 경우 해당 입력 이미지 파일도 같이 옮겨야 합니다.

### `match_image_size` 동작

- `true`
  - `right / left`: 첫 번째 이미지의 **높이**에 맞춰 나머지 이미지를 비율 유지 리사이즈
  - `down / up`: 첫 번째 이미지의 **너비**에 맞춰 나머지 이미지를 비율 유지 리사이즈
- `false`
  - 원본 Crop 해상도를 유지
  - 서로 크기가 다르면 공통 축을 기준으로 중앙 정렬 + padding 후 Stitch

`left` 또는 `up`은 기존 `Stitch Images`를 반복해서 붙이는 방식과 동일하게, 새 이미지가 기존 결과의 앞쪽에 붙도록 최종 순서를 뒤집어 배치합니다.

### 왜 이미지 입력 소켓을 여러 개 만드는 방식이 아닌가?

이 노드는 **"이미지를 붙여 넣으면 한 노드 안에서 바로 관리"** 하는 UX를 목표로 합니다. 그래서 `image_1`, `image_2`, `image_3` 소켓을 계속 늘리는 대신, 입력 이미지를 ComfyUI `input` 폴더에 보관하고 내부 JSON으로 목록/Crop/순서를 관리합니다.

이 방식의 장점:

- 2장 → 10장 → 30장으로 늘어도 노드 소켓이 길어지지 않음
- Crop, 삭제, 순서 변경을 한 노드에서 처리
- Ctrl+V / Drop / 파일 선택을 동일한 이미지 리스트로 통합
- Crop 변경 시 원본 PNG/JPG를 다시 인코딩하지 않음

---

## 🇺🇸 English

### Features

- **Paste multiple images with Ctrl+V** directly into a selected `Multi Stitch Images` node.
- **Per-image crop editor** with a Microsoft Photos-like interaction model.
- **Non-destructive crop**: only normalized crop coordinates are stored; source images are not re-encoded.
- **Reorder / remove** thumbnails with `‹`, `›`, and `×`.
- **Drag & drop** and an **Add images…** file picker.
- Familiar Stitch Images controls:
  - `direction`: `right / down / left / up`
  - `match_image_size`
  - `spacing_width`
  - `spacing_color`: `white / black / red / green / blue`
- Displays an **estimated final resolution** inside the node.
- Standard `IMAGE` output for `Preview Image`, `Save Image`, `VAE Encode`, etc.

### Installation

From your ComfyUI `custom_nodes` directory:

```bash
git clone https://github.com/ssain3d-lgtm/Comfyui-Image-Stitch.git
```

Restart ComfyUI. No extra Python packages are required.

### Usage

1. Add **`Multi Stitch Images`** from `image/transform`.
2. Click the node once so it is selected.
3. Copy one or more images/files and press **Ctrl+V**.
4. Click any thumbnail to open the crop editor.
5. Reorder images with `‹ / ›`, or remove one with `×`.
6. Set direction, size matching, spacing width, and spacing color.
7. Connect the `IMAGE` output to **Preview Image**.
8. Queue the workflow.

Uploaded images are stored in:

```text
ComfyUI/input/multi_stitch/
```

The workflow stores image references plus crop coordinates. If you move the workflow to another machine, move the referenced input images as well.

### Crop editor

- Drag inside the crop box to move it.
- Drag a corner to resize it.
- Drag outside the current crop to draw a new crop.
- Presets: `Free / Original / 1:1 / 4:3 / 3:2 / 16:9 / 9:16`.
- `Reset` restores the full source image.
- `Apply crop` saves coordinates only.

### Design notes

The node intentionally keeps images **inside one visual node** instead of creating an ever-growing list of IMAGE sockets. The frontend uploads pasted/dropped files into the ComfyUI input directory and serializes a compact image list into the workflow. The backend then performs crop → optional size matching → stitch at execution time.

## Compatibility

- Designed for current ComfyUI legacy-canvas/custom-node APIs and the current native clipboard routing (`previewMediaType` + `pasteFiles`).
- Uses only dependencies already shipped with a normal ComfyUI install: PyTorch, Pillow, NumPy.
- No core ComfyUI files are modified.

## Credits

The control names and expected stitch behavior intentionally follow ComfyUI's built-in **Stitch Images** node, which was upstreamed from **Kijai's ComfyUI-KJNodes**. This project adds a multi-image paste/crop/reorder workflow around that interaction model.

## License

MIT
