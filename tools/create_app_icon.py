"""Render the project's own geometric UI mark as a Windows application icon."""
from pathlib import Path
from PIL import Image, ImageDraw

root = Path(__file__).resolve().parents[1]
image = Image.new('RGBA', (256, 256), '#081d26')
draw = ImageDraw.Draw(image)
for box in [(52, 52, 118, 105), (141, 52, 201, 121), (52, 140, 103, 204), (128, 154, 201, 204)]:
    draw.rectangle(box, fill='#d3e3cd')
draw.line([(35, 225), (223, 36)], fill='#081d26', width=20)
target = root / 'web/assets/relic.ico'
target.parent.mkdir(parents=True, exist_ok=True)
image.save(target, sizes=[(16,16),(24,24),(32,32),(48,48),(64,64),(128,128),(256,256)])
