"""아이콘 PNG 파일 생성 스크립트. Pillow 필요: pip install Pillow"""

from pathlib import Path

try:
    from PIL import Image, ImageDraw
except ImportError:
    print("pip install Pillow 실행 후 다시 시도하세요.")
    raise

ICONS_DIR = Path(__file__).parent / "icons"
ICONS_DIR.mkdir(exist_ok=True)

BLURPLE = (88, 101, 242, 255)
WHITE   = (255, 255, 255, 255)


def draw_icon(size: int) -> Image.Image:
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # 원형 배경
    draw.ellipse([0, 0, size - 1, size - 1], fill=BLURPLE)

    # 아래 화살표 (내보내기 상징)
    m = size // 8
    cx = size // 2
    arrow_top = int(size * 0.22)
    arrow_mid = int(size * 0.55)
    arrow_bot = int(size * 0.72)
    w = max(2, size // 12)

    shaft_w = max(2, size // 7)
    draw.rectangle(
        [cx - shaft_w // 2, arrow_top, cx + shaft_w // 2, arrow_mid],
        fill=WHITE,
    )
    # 화살촉
    head = [
        (cx, arrow_bot),
        (cx - size // 4 + m, arrow_mid),
        (cx + size // 4 - m, arrow_mid),
    ]
    draw.polygon(head, fill=WHITE)

    # 밑줄 (내보내기 트레이 라인)
    bar_y = int(size * 0.78)
    bar_h = max(2, size // 14)
    draw.rectangle(
        [m * 2, bar_y, size - m * 2, bar_y + bar_h],
        fill=WHITE,
    )

    return img


for size in [16, 48, 128]:
    icon = draw_icon(size)
    path = ICONS_DIR / f"icon{size}.png"
    icon.save(path)
    print(f"생성됨: {path}")

print("완료!")
