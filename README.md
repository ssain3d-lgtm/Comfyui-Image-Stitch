# Comfyui-Image-Stitch

**Multi Stitch Images** for ComfyUI — paste many images into one node, crop / rotate / flip each image, click an image to edit it, drag its dedicated `≡` handle to reorder, then output a classic stitched strip or a configurable grid.

**[한국어](#-한국어) · [English](#-english)**

---

# 🇰🇷 한국어

## 소개

`Multi Stitch Images`는 여러 이미지를 한 노드에 바로 붙여 넣고 편집한 뒤 하나의 `IMAGE`로 합치는 ComfyUI 커스텀 노드입니다.

- **Ctrl+V 다중 이미지 붙여넣기**
- 이미지 클릭 → **즉시 Edit**
- 전용 **`≡` Drag Handle**로 이미지 순서 변경
- 썸네일 **우클릭 → 원본 이미지 클립보드 복사**
- 이미지별 **Crop / 90° Rotate / Flip H / Flip V**
- Free Crop용 **상/하/좌/우 + 모서리 핸들**
- **Strip / Grid** 레이아웃
- `direction`: `right / down / left / up`
- `match_image_size`
- `spacing_width`
- 기본색 + **Custom spacing color**
- 노드 내부 **예상 최종 해상도 표시**
- 초대형 결과 생성 전 **Output Size Safety Guard**
- 일반 `IMAGE` 출력 → `Preview Image`, `Save Image`, `VAE Encode` 등에 바로 연결
- 추가 Python 패키지 불필요

> 아래 한국어 이미지는 이해를 돕기 위해 일부 버튼/설명을 번역한 가이드 이미지입니다. 실제 노드의 옵션 이름은 ComfyUI에서 영문으로 표시될 수 있습니다.

## 전체 사용 예시

![Multi Stitch Images Korean overview](docs/example-node-ko.svg)

## 설치 — Step by Step

### 방법 A — Git 설치 권장

**1. ComfyUI를 종료합니다.**

**2. ComfyUI의 `custom_nodes` 폴더를 엽니다.**

```text
ComfyUI/custom_nodes/
```

**3. 해당 폴더에서 터미널 / CMD / PowerShell을 엽니다.**

**4. 아래 명령을 실행합니다.**

```bash
git clone https://github.com/ssain3d-lgtm/Comfyui-Image-Stitch.git
```

**5. ComfyUI를 다시 실행합니다.**

**6. 노드 검색에서 `Multi Stitch Images`를 찾습니다.**

```text
image/transform → Multi Stitch Images
```

끝입니다. `pip install`은 필요하지 않습니다.

### 방법 B — ZIP 설치

1. GitHub에서 **Code → Download ZIP**
2. 압축 해제
3. 폴더를 `ComfyUI/custom_nodes/Comfyui-Image-Stitch/`에 넣기
4. ComfyUI 재시작

> 폴더가 `Comfyui-Image-Stitch/Comfyui-Image-Stitch/...`처럼 이중으로 들어가지 않게 확인하세요.

## 업데이트

이미 설치되어 있다면:

```bash
cd Comfyui-Image-Stitch
git pull
```

그 다음 ComfyUI를 완전히 재시작하고, 프론트엔드 변경이 보이지 않으면 브라우저에서 `Ctrl+F5`를 한 번 실행하세요.

## 사용법 — Step by Step

1. **`Multi Stitch Images` 노드를 추가**합니다.
2. 노드를 한 번 클릭해 **선택**합니다.
3. 이미지 파일/브라우저 이미지/스크린샷을 복사한 뒤 **Ctrl+V** 합니다.
4. 편집할 이미지는 **썸네일 이미지 영역을 한 번 클릭**합니다.
5. 순서를 바꾸려면 썸네일 하단 중앙의 **`≡` 핸들만 잡고 드래그**합니다.
   - 썸네일을 **우클릭**하면 `Copy original image #N` 메뉴가 나옵니다. 클릭하면 **편집 전 원본 이미지 전체**가 클립보드에 복사됩니다.
6. `layout_mode`를 선택합니다.
   - `strip` → 기존 Stitch Images처럼 한 줄/한 열로 연결
   - `grid` → 여러 행/열로 자동 배치
7. `direction`, `match_image_size`, `spacing_width`, `spacing_color`를 설정합니다.
8. Grid라면 `grid_columns`를 지정합니다.
9. 원하는 색이 필요하면 `spacing_color = custom` 후 **Custom color** 버튼을 사용합니다.
10. `IMAGE` 출력을 **Preview Image**에 연결하고 Queue를 실행합니다.

## 이미지 편집기

![Multi Stitch Images Korean editor](docs/crop-editor-ko.svg)

썸네일 이미지 영역을 한 번 클릭하면 이미지별 편집기가 열립니다.

- Crop 내부 드래그 → 영역 이동
- **상/하/좌/우 검정 막대 핸들** → 해당 변만 조절
- **모서리 검정 핸들** → 가로/세로 동시 조절
- Crop 바깥 드래그 → 새 Crop 영역 생성
- 비율 프리셋: `Free / Original / 1:1 / 4:3 / 3:2 / 16:9 / 9:16`
- `↶ 90° / ↷ 90°`
- `Flip H / Flip V`
- `Reset crop`
- `Reset all`

회전 / 반전은 **잡아둔 Crop 영역을 그대로 유지**합니다. Crop은 이미지 내용을 따라 함께 회전·반전되므로, 편집 순서에 상관없이 같은 영역이 선택된 상태로 남습니다. Crop을 전체로 되돌리려면 `Reset crop`을 사용하세요.

Crop / 회전 / 반전 정보만 workflow에 저장하는 **비파괴 방식**이라 원본 이미지 파일은 수정하지 않습니다.

## Drag Reorder

Edit 클릭과 Reorder 제스처를 서로 분리했습니다.

- **이미지 영역 클릭** → Edit 즉시 열기
- 썸네일 하단 중앙의 **`≡`만 드래그** → 순서 변경
- 썸네일 **우클릭** → `Copy original image #N` → **원본 이미지 복사**
- Drag 판정 거리는 ComfyUI Canvas 좌표가 아닌 **실제 화면 픽셀 기준**이라 Zoom 배율에 영향을 덜 받습니다.
- 현재 드롭 대상 → 파란 테두리 표시
- `‹ / ›` 버튼으로 한 칸씩 이동도 가능

이 방식은 이미지 클릭이 Drag로 잘못 판정되어 편집기가 안 열리는 문제를 줄이기 위한 설계입니다.

## Strip / Grid

### Strip

기존 ComfyUI `Stitch Images` 방식과 비슷하게 한 방향으로 이미지를 계속 연결합니다.

- `right`
- `left`
- `down`
- `up`

### Grid

`grid_columns`가 최대 열 수가 됩니다.

```text
grid_columns = 3

1  2  3
4  5  6
7  8
```

`direction`에 따라 Grid 채우기 방향도 바뀝니다.

- `right` → 좌 → 우, 위 → 아래
- `left` → 우 → 좌, 위 → 아래
- `down` → 위 → 아래, 좌 → 우
- `up` → 아래 → 위, 좌 → 우

`match_image_size = true`이면 **목록의 첫 번째 이미지**(편집 여부와 무관) 크기를 셀 기준으로 사용하고 다른 이미지는 종횡비를 유지한 채 Fit 합니다. Strip에서도 같은 기준을 씁니다. `direction`이 `left` / `up`이면 그 첫 번째 이미지가 화면상 **마지막**에 그려집니다.

## 파라미터

| 위젯 | 값 | 기본값 |
| --- | --- | --- |
| `direction` | `right` / `down` / `left` / `up` | `right` |
| `match_image_size` | `true` / `false` | `true` |
| `spacing_width` | `0` – `1024` (step 2) | `0` |
| `spacing_color` | `white` / `black` / `red` / `green` / `blue` / `custom` | `white` |
| `layout_mode` | `strip` / `grid` | `strip` |
| `grid_columns` | `1` – `16` | `3` |
| `custom_spacing_color` | `#RRGGBB` (숨김 위젯, 버튼으로 설정) | `#808080` |

`spacing_width`는 홀수도 동작합니다 — step 2는 위젯의 증감 단위일 뿐입니다. 목록에 없는 값을 API로 직접 넣으면 조용히 기본값으로 바뀌지 않고 **에러가 발생**합니다.

## Spacing Color

기본값:

```text
white / black / red / green / blue / custom
```

`custom`을 선택한 뒤 **`Custom color: #808080`** 버튼(현재 값이 함께 표시됩니다)을 누르면 브라우저 색상 선택기가 열립니다. 위젯 이름은 `custom_color_picker`입니다.

`spacing_color`는 **배경색 전체**에 적용됩니다 — 이미지 사이 구분선과, 크기가 다른 이미지 주변의 여백(레터박스)이 같은 색으로 채워집니다. Strip / Grid 어느 쪽에서도 동일합니다.

투명 영역이 있는 PNG는 이 배경색 위에 합성됩니다.

## Output Size Safety Guard

여러 장의 고해상도 이미지를 `match_image_size = false`로 길게 붙이면 결과 Tensor가 매우 커질 수 있습니다. 이 노드는 소스 이미지를 전부 Tensor로 디코딩하기 **전에** 파일 메타데이터만으로 최종 크기와 **소스 이미지 합계 크기**를 함께 계산합니다. 작은 결과물이라도 원본이 거대하면 차단됩니다.

기본 안전 한도:

```text
최종 출력: 134.2 MP (128 MiPixels) 이하
소스 이미지 합계: 134.2 MP (128 MiPixels) 이하
한 변 최대: 131,072 px
이미지 수: 최대 256장
```

한도를 초과하면 예상 해상도 / MP / float32 메모리 크기를 표시하고 실행을 중단합니다. 이 경우 이미지 수를 줄이거나, Crop/Resize를 하거나, Grid를 사용하거나, `match_image_size = true`를 사용하세요.

## 붙여넣기 / 저장 방식

최신 ComfyUI의 이미지 paste routing을 이용합니다. 노드는 `previewMediaType = "image"`와 `pasteFiles()`를 제공하여 전역 Ctrl+V 가로채기를 최소화합니다.

붙여넣거나 추가한 이미지는 다음 위치에 저장됩니다.

```text
ComfyUI/input/multi_stitch/
```

Workflow에는 다음 상태가 저장됩니다.

- 이미지 참조
- Crop 좌표
- Rotation
- Horizontal / Vertical Flip
- 이미지 순서

Workflow를 다른 PC로 옮길 경우 참조된 입력 이미지도 같이 옮겨야 합니다.

---

# 🇺🇸 English

## Overview

`Multi Stitch Images` is a ComfyUI custom node for pasting many images directly into one node, editing each image, and composing the result into a single `IMAGE` output.

- **Paste multiple images with Ctrl+V**
- Click an image → **open Edit immediately**
- Dedicated **`≡` drag handle** for reordering
- **Right-click a thumbnail to copy the original image** to the clipboard
- Per-image **Crop / 90° Rotate / Flip H / Flip V**
- **Top / bottom / left / right + corner handles** for Free Crop
- **Strip / Grid** layouts
- `direction`: `right / down / left / up`
- `match_image_size`
- `spacing_width`
- Built-in colors + **Custom spacing color**
- **Estimated final resolution** displayed inside the node
- **Output Size Safety Guard** before giant tensors are allocated
- Standard `IMAGE` output → `Preview Image`, `Save Image`, `VAE Encode`, etc.
- No extra Python packages required

## Full workflow example

![Multi Stitch Images English overview](docs/example-node-en.svg)

## Installation — Step by Step

### Method A — Git install recommended

**1. Close ComfyUI.**

**2. Open your ComfyUI `custom_nodes` folder.**

```text
ComfyUI/custom_nodes/
```

**3. Open Terminal / CMD / PowerShell in that folder.**

**4. Run:**

```bash
git clone https://github.com/ssain3d-lgtm/Comfyui-Image-Stitch.git
```

**5. Start ComfyUI again.**

**6. Search for `Multi Stitch Images`.**

```text
image/transform → Multi Stitch Images
```

Done. No `pip install` is required.

### Method B — ZIP install

1. GitHub → **Code → Download ZIP**
2. Extract the archive
3. Place it at `ComfyUI/custom_nodes/Comfyui-Image-Stitch/`
4. Restart ComfyUI

> Make sure you do not end up with a nested folder such as `Comfyui-Image-Stitch/Comfyui-Image-Stitch/...`.

## Updating

If already installed:

```bash
cd Comfyui-Image-Stitch
git pull
```

Then fully restart ComfyUI. If frontend changes are still cached, refresh the browser once with `Ctrl+F5`.

## Usage — Step by Step

1. Add the **`Multi Stitch Images`** node.
2. Click the node once so it is **selected**.
3. Copy image files, a browser image, or a screenshot and press **Ctrl+V**.
4. **Single-click the image area** of a thumbnail to Crop / Rotate / Flip it.
5. To reorder, drag only the **`≡` handle** at the bottom center of the thumbnail.
   - **Right-click** a thumbnail for `Copy original image #N`. It copies the **whole original image, before any edits**, to the clipboard.
6. Choose `layout_mode`.
   - `strip` → classic one-row / one-column stitching
   - `grid` → automatic multi-row / multi-column layout
7. Set `direction`, `match_image_size`, `spacing_width`, and `spacing_color`.
8. In Grid mode, set `grid_columns`.
9. For an arbitrary color, choose `spacing_color = custom` and use the **Custom color** button.
10. Connect the `IMAGE` output to **Preview Image** and queue the workflow.

## Per-image editor

![Multi Stitch Images English editor](docs/crop-editor-en.svg)

Single-click the thumbnail image area to open the editor.

- Drag inside the crop → move the crop
- Drag the **black top / bottom / left / right handle** → resize one edge
- Drag a **black corner handle** → resize two edges
- Drag outside the crop → draw a new crop
- Aspect presets: `Free / Original / 1:1 / 4:3 / 3:2 / 16:9 / 9:16`
- `↶ 90° / ↷ 90°`
- `Flip H / Flip V`
- `Reset crop`
- `Reset all`

Rotating or flipping **keeps the crop you drew**. The crop travels with the image content, so the same region stays selected no matter what order you edit in. Use `Reset crop` to go back to the full frame.

Crop / rotation / flip settings are stored **non-destructively** in the workflow. The source image file is not modified.

## Drag Reorder

Editing and reordering use separate gestures.

- **Click image area** → open editor immediately
- Drag the bottom-center **`≡` handle** → reorder
- **Right-click** a thumbnail → `Copy original image #N` → copies the original image
- Drag threshold is measured in **real browser pixels**, not ComfyUI graph coordinates, so canvas zoom does not make normal clicks behave like drags.
- Current drop target → blue border
- `‹ / ›` buttons remain available for one-step movement

## Strip / Grid

### Strip

Works like the familiar ComfyUI `Stitch Images` behavior, extending the composition in one direction.

- `right`
- `left`
- `down`
- `up`

### Grid

`grid_columns` defines the maximum number of columns.

```text
grid_columns = 3

1  2  3
4  5  6
7  8
```

Grid fill order follows `direction`.

- `right` → left-to-right, then top-to-bottom
- `left` → right-to-left, then top-to-bottom
- `down` → top-to-bottom, then left-to-right
- `up` → bottom-to-top, then left-to-right

With `match_image_size = true`, the **first image in the list** — edited or not — defines the cell size, and the remaining images are fit into that cell while preserving aspect ratio. Strip mode uses the same reference. With `direction` set to `left` / `up` that first image is drawn **last** on screen.

## Parameters

| Widget | Values | Default |
| --- | --- | --- |
| `direction` | `right` / `down` / `left` / `up` | `right` |
| `match_image_size` | `true` / `false` | `true` |
| `spacing_width` | `0` – `1024` (step 2) | `0` |
| `spacing_color` | `white` / `black` / `red` / `green` / `blue` / `custom` | `white` |
| `layout_mode` | `strip` / `grid` | `strip` |
| `grid_columns` | `1` – `16` | `3` |
| `custom_spacing_color` | `#RRGGBB` (hidden widget, set via the button) | `#808080` |

Odd `spacing_width` values work — the step of 2 is only the widget's increment. A value outside the listed set, passed directly through the API, **raises an error** rather than being silently replaced with the default.

## Spacing Color

Built-in values:

```text
white / black / red / green / blue / custom
```

Choose `custom`, then click the **`Custom color: #808080`** button — it shows the current value — to open the browser color picker. The widget is named `custom_color_picker`.

`spacing_color` is the **whole background**: it fills both the separators between images and the letterbox padding around images of a different size, identically in Strip and Grid.

A PNG with transparency is composited onto that background color.

## Output Size Safety Guard

A long strip of high-resolution images can create a very large float32 tensor, especially with `match_image_size = false`. From file metadata alone — **before** any source is decoded — the node estimates both the final canvas and the **combined size of the sources**, so a small output built from huge originals is rejected too.

Default safety limits:

```text
Final output:        max 134.2 MP (128 MiPixels)
Source images total: max 134.2 MP (128 MiPixels)
Maximum side:        131,072 px
Images per node:     max 256
```

If the limit would be exceeded, execution stops with the estimated resolution, megapixels, and approximate float32 output memory. Reduce the image count, Crop/Resize the sources, use Grid, or enable `match_image_size`.

## Paste / storage behavior

The node uses current ComfyUI image paste routing through `previewMediaType = "image"` and `pasteFiles()`, minimizing global Ctrl+V interception.

Pasted or added images are stored in:

```text
ComfyUI/input/multi_stitch/
```

The workflow stores:

- Image references
- Crop coordinates
- Rotation
- Horizontal / Vertical Flip
- Image order

If you move the workflow to another machine, copy the referenced input images as well.

---

## Compatibility / Testing

- Designed for current ComfyUI custom-node / canvas APIs and native image clipboard routing.
- Requires **Python 3.10+** and the dependencies normally included with ComfyUI: **PyTorch, Pillow, NumPy**. No extra packages.
- Does **not** modify ComfyUI core files.
- Backend limit: **256 images per node**.
- Output safety limit: **134.2 MP (128 MiPixels) / 131,072 px per side**, plus the same cap on the combined source size.
- GitHub Actions runs the suite on Python 3.10 and 3.12: a package-import smoke test (so a node that would not load in ComfyUI fails CI), `INPUT_TYPES` widget order against the `stitch()` signature, per-pixel rotation/flip checks across all 16 transform combinations, Strip directions, Grid placement with no unused row or column, Crop/rotation dimensions, spacing-colour fill in both layouts, transparency compositing, rejected enum values, unsafe paths, the image-count cap, and the output/input size guards. Every `web/*.js` file is syntax-checked.

## Credits

The classic strip controls and expected behavior follow ComfyUI's built-in **Stitch Images** node, which was upstreamed from **Kijai's ComfyUI-KJNodes**. This project adds multi-image paste, non-destructive editing, dedicated drag-handle reordering, Grid composition, custom spacing colors, and output safety checks around that model.

## License

MIT