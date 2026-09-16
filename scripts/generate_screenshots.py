import os
from PIL import Image, ImageDraw, ImageFont, ImageFilter

W, H = 1280, 800

def create_base_canvas(badge_text, title_text, sub_text, badge_color=(16, 185, 129)):
    canvas = Image.new('RGBA', (W, H), (15, 23, 42, 255))
    draw = ImageDraw.Draw(canvas)
    for y in range(H):
        r = int(11 + (30 - 11) * (y / H))
        g = int(17 + (41 - 17) * (y / H))
        b = int(32 + (59 - 32) * (y / H))
        draw.line([(0, y), (W, y)], fill=(r, g, b, 255))
    
    try:
        title_font = ImageFont.truetype('segoeuib.ttf', 36)
        sub_font = ImageFont.truetype('segoeui.ttf', 19)
        badge_font = ImageFont.truetype('segoeuib.ttf', 12)
    except:
        title_font = ImageFont.load_default()
        sub_font = ImageFont.load_default()
        badge_font = ImageFont.load_default()
    
    bbox = draw.textbbox((0, 0), badge_text, font=badge_font)
    bw = (bbox[2] - bbox[0]) + 32
    bx = (W - bw) // 2
    draw.rounded_rectangle([(bx, 28), (bx + bw, 52)], radius=12, fill=(30, 41, 59, 255), outline=(*badge_color, 120))
    draw.text((bx + 16, 33), badge_text, fill=(*badge_color, 255), font=badge_font)
    
    tbox = draw.textbbox((0, 0), title_text, font=title_font)
    tw = tbox[2] - tbox[0]
    draw.text(((W - tw) // 2, 60), title_text, fill=(255, 255, 255, 255), font=title_font)
    
    sbox = draw.textbbox((0, 0), sub_text, font=sub_font)
    sw = sbox[2] - sbox[0]
    draw.text(((W - sw) // 2, 106), sub_text, fill=(148, 163, 184, 255), font=sub_font)
    
    return canvas

def round_and_shadow(img, w, h):
    mask = Image.new('L', (w, h), 0)
    md = ImageDraw.Draw(mask)
    md.rounded_rectangle([(0, 0), (w, h)], radius=12, fill=255)
    
    sh = Image.new('RGBA', (w + 40, h + 40), (0, 0, 0, 0))
    sd = ImageDraw.Draw(sh)
    sd.rounded_rectangle([(15, 15), (w + 25, h + 25)], radius=16, fill=(0, 0, 0, 160))
    sh = sh.filter(ImageFilter.GaussianBlur(16))
    return mask, sh

# ----------------- SCREENSHOT 3: Dossier Export -----------------
user_img_path = r'C:\Users\DELL COMPUTER\.gemini\antigravity-ide\brain\676de787-1f8a-4390-a1d1-2a4a41e32f95\.user_uploaded\media_1789238103544.png'
ui = Image.open(user_img_path).convert('RGBA')

uw, uh = ui.size
sidebar_crop = ui.crop((int(uw * 0.74), 0, uw, uh))

c3 = create_base_canvas(
    'PRO PRODUCTIVITY FEATURE',
    '1-Click Research Dossier & Brief Export',
    'Aggregate matching quotes, file names, and citations into an executive brief instantly.',
    badge_color=(16, 185, 129)
)

sw_w = 460
sw_scale = sw_w / float(sidebar_crop.width)
sw_h = int(sidebar_crop.height * sw_scale)
sidebar_resized = sidebar_crop.resize((sw_w, sw_h), Image.Resampling.LANCZOS)

card_left = Image.new('RGBA', (sw_w, 580), (255, 255, 255, 255))
card_left.paste(sidebar_resized, (0, 0), sidebar_resized)

card_right = Image.new('RGBA', (650, 580), (255, 255, 255, 255))
rdraw = ImageDraw.Draw(card_right)

rdraw.rectangle([(0, 0), (650, 48)], fill=(248, 250, 252, 255))
rdraw.text((24, 14), 'Prism Research Dossier - "welcome" query', fill=(30, 41, 59, 255), font=ImageFont.truetype('segoeuib.ttf', 16))
rdraw.text((490, 14), 'Google Docs Export [OK]', fill=(16, 185, 129, 255), font=ImageFont.truetype('segoeuib.ttf', 12))
rdraw.line([(0, 48), (650, 48)], fill=(226, 232, 240, 255))

rdraw.text((36, 75), 'EXECUTIVE SUMMARY', fill=(100, 116, 139, 255), font=ImageFont.truetype('segoeuib.ttf', 12))
rdraw.text((36, 95), 'Prism scanned 19 Google Drive files and compiled 27 matching excerpts.', fill=(51, 65, 85, 255), font=ImageFont.truetype('segoeui.ttf', 14))

# Entry 1
rdraw.rounded_rectangle([(36, 135), (614, 255)], radius=8, fill=(248, 250, 252, 255), outline=(226, 232, 240, 255))
rdraw.text((52, 150), 'untitled (Google Doc) - Page 1 - Paragraph 3', fill=(14, 116, 144, 255), font=ImageFont.truetype('segoeuib.ttf', 13))
rdraw.text((52, 175), '\"...I am not looking for a job title; I am looking for a place to build\nsomething meaningful over time. I would welcome the opportunity...\"', fill=(51, 65, 85, 255), font=ImageFont.truetype('segoeui.ttf', 13))
rdraw.text((52, 222), 'Direct link: https://docs.google.com/document/d/1A9.../edit', fill=(59, 130, 246, 255), font=ImageFont.truetype('segoeui.ttf', 11))

# Entry 2
rdraw.rounded_rectangle([(36, 270), (614, 390)], radius=8, fill=(248, 250, 252, 255), outline=(226, 232, 240, 255))
rdraw.text((52, 285), 'Evaluation 2025.pdf - Page 4 - Section B', fill=(14, 116, 144, 255), font=ImageFont.truetype('segoeuib.ttf', 13))
rdraw.text((52, 310), '\"...All stakeholders extended a warm welcome during the initial review\nphase, confirming the project milestones for Q2...\"', fill=(51, 65, 85, 255), font=ImageFont.truetype('segoeui.ttf', 13))
rdraw.text((52, 357), 'Direct link: https://drive.google.com/file/d/2X8.../view', fill=(59, 130, 246, 255), font=ImageFont.truetype('segoeui.ttf', 11))

# Entry 3
rdraw.rounded_rectangle([(36, 405), (614, 525)], radius=8, fill=(248, 250, 252, 255), outline=(226, 232, 240, 255))
rdraw.text((52, 420), 'untitled sheet (Google Sheets) - Sheet 1 (A12)', fill=(14, 116, 144, 255), font=ImageFont.truetype('segoeuib.ttf', 13))
rdraw.text((52, 445), '\"...New client onboarding sequence initiated: welcome packet delivered\nand confirmed by regional representative...\"', fill=(51, 65, 85, 255), font=ImageFont.truetype('segoeui.ttf', 13))
rdraw.text((52, 492), 'Direct link: https://docs.google.com/spreadsheets/d/3K7.../edit', fill=(59, 130, 246, 255), font=ImageFont.truetype('segoeui.ttf', 11))

m_left, sh_left = round_and_shadow(card_left, sw_w, 580)
m_right, sh_right = round_and_shadow(card_right, 650, 580)

pos_y = 158
lx, rx = 60, 570
c3.paste(sh_left, (lx - 20, pos_y - 20), sh_left)
c3.paste(card_left, (lx, pos_y), m_left)
c3.paste(sh_right, (rx - 20, pos_y - 20), sh_right)
c3.paste(card_right, (rx, pos_y), m_right)

out3 = os.path.abspath(os.path.join('extension', 'screenshot_3_dossier_1280x800.png'))
with open(out3, 'wb') as f:
    c3.convert('RGB').save(f, 'PNG', optimize=True)
print('Saved screenshot 3:', out3)

# ----------------- SCREENSHOT 4: Exact Phrase & Filters -----------------
c4 = create_base_canvas(
    'PRECISION SEARCH TOOLS',
    'Exact Phrase, Case-Sensitive & Scope Filters',
    'Find exact terms, enforce capitalization, and filter Docs, Sheets, Slides, or PDFs.',
    badge_color=(245, 158, 11)
)

fcard_w = 860
fcard_h = 580
fcard = Image.new('RGBA', (fcard_w, fcard_h), (255, 255, 255, 255))
fdraw = ImageDraw.Draw(fcard)

fdraw.rectangle([(0, 0), (fcard_w, 60)], fill=(248, 250, 252, 255))
fdraw.text((28, 18), 'Prism Search Precision Controls', fill=(15, 23, 42, 255), font=ImageFont.truetype('segoeuib.ttf', 18))
fdraw.text((750, 18), 'PRO ACTIVE', fill=(245, 158, 11, 255), font=ImageFont.truetype('segoeuib.ttf', 12))
fdraw.line([(0, 60), (fcard_w, 60)], fill=(226, 232, 240, 255))

fdraw.rounded_rectangle([(36, 80), (824, 126)], radius=8, fill=(255, 255, 255, 255), outline=(59, 130, 246, 255), width=2)
fdraw.text((54, 92), 'Search term: "welcome" [Exact Sequence Enforced]', fill=(30, 41, 59, 255), font=ImageFont.truetype('segoeui.ttf', 15))

fdraw.rounded_rectangle([(36, 142), (210, 178)], radius=18, fill=(239, 246, 255, 255), outline=(59, 130, 246, 255), width=2)
fdraw.text((52, 150), '"" Exact Phrase  [OK]', fill=(37, 99, 235, 255), font=ImageFont.truetype('segoeuib.ttf', 13))

fdraw.rounded_rectangle([(226, 142), (370, 178)], radius=18, fill=(239, 246, 255, 255), outline=(59, 130, 246, 255), width=2)
fdraw.text((242, 150), 'Aa Match Case  [OK]', fill=(37, 99, 235, 255), font=ImageFont.truetype('segoeuib.ttf', 13))

fdraw.rounded_rectangle([(386, 142), (590, 178)], radius=18, fill=(248, 250, 252, 255), outline=(203, 213, 225, 255), width=1)
fdraw.text((402, 150), 'Folder: In Current Folder Only', fill=(71, 85, 105, 255), font=ImageFont.truetype('segoeuib.ttf', 13))

fdraw.rounded_rectangle([(606, 142), (824, 178)], radius=18, fill=(248, 250, 252, 255), outline=(203, 213, 225, 255), width=1)
fdraw.text((622, 150), 'All Formats (Doc/PDF/Sheet)', fill=(71, 85, 105, 255), font=ImageFont.truetype('segoeuib.ttf', 13))

fdraw.text((36, 200), 'Found 27 exact matches in 19 files (fuzzy matches excluded)', fill=(100, 116, 139, 255), font=ImageFont.truetype('segoeui.ttf', 13))

# Result card 1
fdraw.rounded_rectangle([(36, 230), (824, 380)], radius=10, fill=(255, 255, 255, 255), outline=(226, 232, 240, 255), width=1)
fdraw.text((54, 245), 'untitled (Google Doc)', fill=(30, 41, 59, 255), font=ImageFont.truetype('segoeuib.ttf', 15))
fdraw.text((54, 275), '\"...I am not looking for a job title; I am looking for a place to build something meaningful over time.\nI would welcome the opportunity to speak with your team. Thank you for your consideration.\"', fill=(71, 85, 105, 255), font=ImageFont.truetype('segoeui.ttf', 13))
fdraw.rounded_rectangle([(96, 292), (158, 310)], radius=3, fill=(254, 240, 138, 140))
fdraw.text((98, 292), 'welcome', fill=(133, 77, 14, 255), font=ImageFont.truetype('segoeuib.ttf', 13))

fdraw.rounded_rectangle([(54, 335), (204, 365)], radius=6, fill=(37, 99, 235, 255))
fdraw.text((70, 342), 'Jump to paragraph ->', fill=(255, 255, 255, 255), font=ImageFont.truetype('segoeuib.ttf', 12))

# Result card 2
fdraw.rounded_rectangle([(36, 400), (824, 550)], radius=10, fill=(255, 255, 255, 255), outline=(226, 232, 240, 255), width=1)
fdraw.text((54, 415), 'Evaluation 2025.pdf (Page 4)', fill=(30, 41, 59, 255), font=ImageFont.truetype('segoeuib.ttf', 15))
fdraw.text((54, 445), '\"...All stakeholders extended a warm welcome during the initial review phase, confirming the\nproject milestones and financial allocations for Q2 2026...\"', fill=(71, 85, 105, 255), font=ImageFont.truetype('segoeui.ttf', 13))
fdraw.rounded_rectangle([(244, 445), (306, 463)], radius=3, fill=(254, 240, 138, 140))
fdraw.text((246, 445), 'welcome', fill=(133, 77, 14, 255), font=ImageFont.truetype('segoeuib.ttf', 13))

fdraw.rounded_rectangle([(54, 505), (204, 535)], radius=6, fill=(37, 99, 235, 255))
fdraw.text((70, 512), 'Jump to paragraph ->', fill=(255, 255, 255, 255), font=ImageFont.truetype('segoeuib.ttf', 12))

m4, sh4 = round_and_shadow(fcard, fcard_w, fcard_h)
fc_x = (W - fcard_w) // 2
fc_y = 158

c4.paste(sh4, (fc_x - 20, fc_y - 20), sh4)
c4.paste(fcard, (fc_x, fc_y), m4)

out4 = os.path.abspath(os.path.join('extension', 'screenshot_4_filters_1280x800.png'))
with open(out4, 'wb') as f:
    c4.convert('RGB').save(f, 'PNG', optimize=True)
print('Saved screenshot 4:', out4)
