#!/usr/bin/env python3
"""
Guitar Tab Video Extractor
Extracts tab notation from video files and generates A4 PDF sheet music.
"""

import argparse
import os
import sys
import tempfile
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageEnhance, ImageFilter
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.pdfgen import canvas


def download_video(url: str, output_dir: str) -> str:
    """Download video using yt-dlp and return the file path."""
    import subprocess

    output_template = os.path.join(output_dir, "video.%(ext)s")
    cmd = [
        "yt-dlp",
        "--no-playlist",
        "--format", "bestvideo[height<=1080][ext=mp4]/bestvideo[height<=1080]/best[height<=1080]",
        "--output", output_template,
        url,
    ]
    print(f"Downloading video from: {url}")
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"yt-dlp failed: {result.stderr}")

    for f in Path(output_dir).glob("video.*"):
        if f.suffix in (".mp4", ".webm", ".mkv", ".avi"):
            print(f"Downloaded: {f}")
            return str(f)

    raise RuntimeError("Downloaded video file not found")


def detect_tab_region(frame: np.ndarray) -> tuple[int, int, int, int] | None:
    """
    Detect the tab notation region in a frame.
    Returns (x, y, w, h) or None if not detected.

    Looks for a band of 4–6 evenly-spaced, nearly-full-width horizontal lines
    (guitar/bass strings) that form the tab staff.
    """
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    h, w = gray.shape

    # Detect long horizontal lines using a wide morphological kernel
    kernel_w = max(w // 6, 50)
    kernel_h = cv2.getStructuringElement(cv2.MORPH_RECT, (kernel_w, 1))
    horizontal = cv2.morphologyEx(gray, cv2.MORPH_OPEN, kernel_h)

    # Binarize: white = detected horizontal line content
    _, binary = cv2.threshold(horizontal, 30, 255, cv2.THRESH_BINARY_INV)

    # Row density: fraction of the row covered by detected lines
    row_density = np.sum(binary == 255, axis=1) / w

    # Collect rows that look like tab strings (high horizontal coverage)
    line_threshold = 0.5
    line_rows = np.where(row_density > line_threshold)[0]
    if len(line_rows) < 4:
        return None

    # Group contiguous line rows into bands (individual string lines)
    bands: list[tuple[int, int]] = []
    start = line_rows[0]
    prev = line_rows[0]
    for r in line_rows[1:]:
        if r - prev > 3:  # gap > 3px = new band
            bands.append((start, prev))
            start = r
        prev = r
    bands.append((start, prev))

    if len(bands) < 4:
        return None

    # Filter: keep only bands that look evenly spaced (tab staff heuristic)
    # Try every consecutive window of 4–6 bands with uniform spacing
    best_region = None
    for n in (6, 5, 4):
        if len(bands) < n:
            continue
        for i in range(len(bands) - n + 1):
            window = bands[i:i + n]
            centers = [(b[0] + b[1]) / 2 for b in window]
            diffs = [centers[j + 1] - centers[j] for j in range(len(centers) - 1)]
            mean_diff = sum(diffs) / len(diffs)
            if mean_diff < 4:
                continue
            variance = sum((d - mean_diff) ** 2 for d in diffs) / len(diffs)
            # Coefficient of variation < 25% → evenly spaced
            if (variance ** 0.5 / mean_diff) < 0.25:
                top = max(0, window[0][0] - int(mean_diff * 0.5))
                bottom = min(h - 1, window[-1][1] + int(mean_diff * 0.5))
                region_h = bottom - top
                if region_h > h * 0.04:
                    best_region = (0, top, w, region_h)
                    break
        if best_region:
            break

    return best_region


def detect_horizontal_scroll(
    prev: np.ndarray,
    curr: np.ndarray,
    max_scroll: int = 300,
) -> int:
    """
    Detect how many pixels the tab has scrolled left between two frames.
    Takes a wide template from the centre of prev (avoids cut-off edges)
    and searches for it shifted left in curr.
    Returns positive integer = pixels scrolled left (new content on right).
    Returns 0 if scroll cannot be determined.
    """
    h, w = prev.shape[:2]
    if w < max_scroll * 2 + 50:
        return 0

    # Template: centre portion, excluding the outermost max_scroll columns
    # (those may be cut off in a scrolled frame)
    t_start = max_scroll
    t_end = w - max_scroll
    if t_end - t_start < 30:
        return 0

    template = prev[:, t_start:t_end]

    # Search region: same right boundary as template, extended left by max_scroll
    search_region = curr[:, 0:t_end]
    if search_region.shape[1] < (t_end - t_start):
        return 0

    result = cv2.matchTemplate(
        search_region.astype(np.float32),
        template.astype(np.float32),
        cv2.TM_CCOEFF_NORMED,
    )
    _, max_val, _, max_loc = cv2.minMaxLoc(result)

    if max_val < 0.70:
        return 0  # No reliable match

    # matched_x: position of template in curr
    matched_x = max_loc[0]
    scroll = t_start - matched_x  # positive = content moved left = tab scrolled left
    return max(0, scroll)


def _is_tab_frame(gray: np.ndarray, min_brightness: float = 140.0) -> bool:
    """
    Return True if this region looks like a tab notation frame.
    Tab frames have a light background (white paper/overlay).
    Dark frames are performance video with no tab visible.
    """
    return float(np.mean(gray)) >= min_brightness


def extract_tab_frames(
    video_path: str,
    tab_region: tuple[int, int, int, int] | None = None,
    sample_interval: float = 0.5,
    min_scroll_px: int = 5,
    min_brightness: float = 140.0,
) -> tuple[list[np.ndarray], list[int]]:
    """
    Extract tab frames from video, tracking horizontal scroll offsets.
    Skips frames where the region is too dark (no tab visible).

    Returns:
        (frames, offsets) where offsets[i] is the scroll from frames[i-1] to frames[i].
        offsets[0] is always 0 (no predecessor).
    """
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        raise RuntimeError(f"Cannot open video: {video_path}")

    fps = cap.get(cv2.CAP_PROP_FPS)
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    frame_step = max(1, int(fps * sample_interval))
    duration = total_frames / fps

    print(f"Video: {duration:.1f}s, {fps:.1f}fps, sampling every {sample_interval}s")

    # Auto-detect tab region from a few sample frames
    if tab_region is None:
        print("Auto-detecting tab region...")
        tab_region = _auto_detect_region(cap, total_frames)
        if tab_region:
            x, y, w, h = tab_region
            print(f"Detected tab region: x={x}, y={y}, w={w}, h={h}")
        else:
            print("Could not auto-detect tab region, using full frame")

    frames: list[np.ndarray] = []
    offsets: list[int] = []
    prev_gray: np.ndarray | None = None
    skipped_dark = 0
    frame_idx = 0

    while frame_idx < total_frames:
        cap.set(cv2.CAP_PROP_POS_FRAMES, frame_idx)
        ret, frame = cap.read()
        if not ret:
            break

        # Crop to tab region
        if tab_region:
            x, y, w, h = tab_region
            roi = frame[y: y + h, x: x + w]
        else:
            roi = frame

        gray = cv2.cvtColor(roi, cv2.COLOR_BGR2GRAY)

        # Skip dark frames — they are performance video, not tab notation
        if not _is_tab_frame(gray, min_brightness):
            skipped_dark += 1
            frame_idx += frame_step
            continue

        if prev_gray is None:
            frames.append(gray.copy())
            offsets.append(0)
            prev_gray = gray.copy()
        else:
            scroll = detect_horizontal_scroll(prev_gray, gray)
            if scroll >= min_scroll_px:
                frames.append(gray.copy())
                offsets.append(scroll)
                prev_gray = gray.copy()

        progress = frame_idx / total_frames * 100
        print(f"\r  Extracting: {progress:.1f}% ({len(frames)} frames, {skipped_dark} dark skipped)", end="", flush=True)

        frame_idx += frame_step

    cap.release()
    print(f"\nExtracted {len(frames)} frames ({skipped_dark} dark frames skipped)")
    return frames, offsets


def _auto_detect_region(
    cap: cv2.VideoCapture,
    total_frames: int,
) -> tuple[int, int, int, int] | None:
    """Sample a few frames to auto-detect the tab region."""
    sample_positions = [
        int(total_frames * 0.15),
        int(total_frames * 0.35),
        int(total_frames * 0.55),
        int(total_frames * 0.75),
    ]
    candidates = []
    for pos in sample_positions:
        cap.set(cv2.CAP_PROP_POS_FRAMES, pos)
        ret, frame = cap.read()
        if not ret:
            continue
        region = detect_tab_region(frame)
        if region:
            candidates.append(region)

    if not candidates:
        return None

    # Use median of detected region boundaries
    tops = sorted(c[1] for c in candidates)
    bottoms = sorted(c[1] + c[3] for c in candidates)
    median_top = tops[len(tops) // 2]
    median_bottom = bottoms[len(bottoms) // 2]
    width = candidates[0][2]
    region_h = median_bottom - median_top
    if region_h < 20:
        return None
    return (0, median_top, width, region_h)


def stitch_horizontal(
    frames: list[np.ndarray],
    offsets: list[int],
) -> np.ndarray:
    """
    Stitch tab frames into a single wide image.
    For each frame after the first, append only the new right-edge strip
    (the portion not covered by the previous frame).
    """
    if not frames:
        raise ValueError("No frames to stitch")
    if len(frames) == 1:
        return frames[0]

    print("Stitching frames horizontally...")
    result = frames[0].copy()

    for i, (frame, scroll) in enumerate(zip(frames[1:], offsets[1:]), 1):
        if scroll <= 0:
            continue
        # The new content is the rightmost `scroll` columns of the current frame
        new_strip = frame[:, -scroll:]
        if new_strip.shape[1] > 0 and new_strip.shape[0] == result.shape[0]:
            result = np.hstack([result, new_strip])
        elif new_strip.shape[0] != result.shape[0]:
            # Height mismatch: resize strip to match
            resized = cv2.resize(new_strip, (new_strip.shape[1], result.shape[0]))
            result = np.hstack([result, resized])

        print(f"\r  Stitching: {i}/{len(frames)-1} ({result.shape[1]}px wide)", end="", flush=True)

    print(f"\nStitched image: {result.shape[1]}w × {result.shape[0]}h px")
    return result


def _frame_similarity(a: np.ndarray, b: np.ndarray) -> float:
    """Compute pixel-level similarity between two grayscale images (0–1)."""
    if a.shape != b.shape:
        b = cv2.resize(b, (a.shape[1], a.shape[0]))
    diff = cv2.absdiff(a, b)
    return 1.0 - (np.mean(diff) / 255.0)


def enhance_tab_image(img: np.ndarray) -> Image.Image:
    """Enhance tab image for clean PDF output."""
    mean_brightness = float(np.mean(img))

    pil_img = Image.fromarray(img)
    enhancer = ImageEnhance.Contrast(pil_img)
    pil_img = enhancer.enhance(2.0)
    pil_img = pil_img.filter(ImageFilter.SHARPEN)
    gray_arr = np.array(pil_img)

    # Only binarize if image is bright enough to be tab notation (light background)
    # Dark images (video content) must not be binarized — they become solid black
    if mean_brightness >= 100:
        _, binary = cv2.threshold(gray_arr, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
        # If binarization produced >80% black pixels it's probably not tab — skip it
        black_ratio = np.sum(binary == 0) / binary.size
        if black_ratio < 0.80:
            return Image.fromarray(binary)

    # Fallback: return contrast-enhanced grayscale without binarization
    return pil_img


def create_pdf(
    tab_image: np.ndarray,
    output_path: str,
    title: str = "Guitar Tab",
    margin_mm: float = 15.0,
    row_gap_mm: float = 8.0,
) -> None:
    """
    Render the wide horizontal tab image onto A4 pages.

    The long horizontal tab strip is wrapped into rows (like text),
    each row fitting within the page content width. Rows stack vertically
    and overflow to additional pages as needed.
    """
    pil_tab = enhance_tab_image(tab_image)
    tab_w_px, tab_h_px = pil_tab.size

    page_w_pt, page_h_pt = A4
    margin = margin_mm * mm
    row_gap = row_gap_mm * mm
    content_w_pt = page_w_pt - 2 * margin

    # Scale factor: map tab pixel width to one "row" of PDF content width
    # Each row in the PDF = content_w_pt wide
    # Row height in PDF points = tab_h_px * (content_w_pt / content_w_pt) ... keep aspect ratio
    row_h_pt = tab_h_px * (content_w_pt / content_w_pt)  # = tab_h_px scaled by 1.0
    # Actually scale properly: if one row is content_w_pt wide and tab_h_px tall in pixels,
    # the PDF row height = tab_h_px * (content_w_pt / tab_w_px_per_row)
    # We'll compute per-row below.

    # Compute how many pixels fit in one row at the given content width
    # Scale factor for one row: content_w_pt / px_per_row → we want px_per_row
    # such that the rendered height is reasonable.
    # Let's keep the tab's native aspect ratio: scale so width = content_w_pt
    # For a single row: scale = content_w_pt / tab_w_px → row_h_pt = tab_h_px * scale
    # But if the tab is very wide, the rows will be thin. That's correct for tab notation.

    # Number of rows to wrap the tab
    # Each "row" is content_w_pt wide. In pixels, that's content_w_pt/scale pixels.
    # We choose scale based on a target row height of ~40-80pt (reasonable for tab).
    target_row_h_pt = max(40.0, min(80.0, (page_h_pt - 2 * margin) / 6))
    scale = target_row_h_pt / tab_h_px  # pt per pixel
    px_per_row = int(content_w_pt / scale)

    if px_per_row <= 0:
        px_per_row = tab_w_px
    if px_per_row > tab_w_px:
        px_per_row = tab_w_px

    actual_row_h_pt = tab_h_px * scale
    rows_per_page = max(1, int((page_h_pt - 2 * margin) / (actual_row_h_pt + row_gap)))

    # Split tab image into row strips
    n_rows = (tab_w_px + px_per_row - 1) // px_per_row
    print(f"PDF layout: {n_rows} rows × {rows_per_page} rows/page → ~{(n_rows + rows_per_page - 1) // rows_per_page} page(s)")
    print(f"  Row size: {px_per_row}px wide → {content_w_pt:.0f}pt × {actual_row_h_pt:.0f}pt")

    c = canvas.Canvas(output_path, pagesize=A4)
    page_num = 0
    row_on_page = 0

    for row_idx in range(n_rows):
        x_start = row_idx * px_per_row
        x_end = min(x_start + px_per_row, tab_w_px)
        strip_pil = pil_tab.crop((x_start, 0, x_end, tab_h_px))

        # Pad the last row to full width so all rows are the same PDF width
        if strip_pil.size[0] < px_per_row:
            padded = Image.new("L", (px_per_row, tab_h_px), 255)
            padded.paste(strip_pil, (0, 0))
            strip_pil = padded

        # New page if needed
        if row_on_page == 0:
            if page_num > 0:
                c.showPage()
            if page_num == 0:
                c.setFont("Helvetica-Bold", 14)
                c.drawString(margin, page_h_pt - margin + 5 * mm, title)
            c.setFont("Helvetica", 9)
            c.drawCentredString(page_w_pt / 2, margin / 2, str(page_num + 1))
            page_num += 1

        # Y position of this row on the page (rows stack top-to-bottom)
        y_top = page_h_pt - margin - (actual_row_h_pt + row_gap) * row_on_page - actual_row_h_pt

        # Save strip to temp file and draw
        with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as tmp:
            tmp_path = tmp.name
        strip_pil.save(tmp_path, "PNG")
        c.drawImage(tmp_path, margin, y_top, width=content_w_pt, height=actual_row_h_pt)
        os.unlink(tmp_path)

        row_on_page = (row_on_page + 1) % rows_per_page

    c.save()
    print(f"PDF saved: {output_path} ({page_num} page(s))")


def scan_video(
    source: str,
    output_dir: str = ".",
) -> None:
    """
    Diagnostic mode: save annotated sample frames and print detected region.
    Use this to find the correct --region coordinates before running extraction.
    """
    tmp_dir = None
    video_path = source

    if source.startswith("http://") or source.startswith("https://"):
        tmp_dir = tempfile.mkdtemp(prefix="tab_scan_")
        video_path = download_video(source, tmp_dir)

    try:
        cap = cv2.VideoCapture(video_path)
        if not cap.isOpened():
            raise RuntimeError(f"Cannot open video: {video_path}")

        total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        print(f"Video size: {w}×{h}px,  {total} frames")

        positions = [0.1, 0.3, 0.5, 0.7]
        detected_regions = []

        for i, ratio in enumerate(positions):
            cap.set(cv2.CAP_PROP_POS_FRAMES, int(total * ratio))
            ret, frame = cap.read()
            if not ret:
                continue

            region = detect_tab_region(frame)
            if region:
                detected_regions.append(region)
                x, y, rw, rh = region
                cv2.rectangle(frame, (x, y), (x + rw, y + rh), (0, 255, 0), 3)
                cv2.putText(frame, f"Detected: x={x} y={y} w={rw} h={rh}",
                            (10, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 255, 0), 2)
            else:
                cv2.putText(frame, "No tab region detected",
                            (10, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 0, 255), 2)

            # Draw horizontal guide lines every 10% of height
            for pct in range(10, 100, 10):
                gy = int(h * pct / 100)
                cv2.line(frame, (0, gy), (w, gy), (100, 100, 255), 1)
                cv2.putText(frame, f"y={gy}", (5, gy - 4),
                            cv2.FONT_HERSHEY_SIMPLEX, 0.4, (100, 100, 255), 1)

            out_path = os.path.join(output_dir, f"scan_frame_{i+1}.jpg")
            cv2.imwrite(out_path, frame)
            print(f"Saved: {out_path}  (region: {region})")

        cap.release()

        if detected_regions:
            tops = sorted(r[1] for r in detected_regions)
            bottoms = sorted(r[1] + r[3] for r in detected_regions)
            med_y = tops[len(tops) // 2]
            med_h = bottoms[len(bottoms) // 2] - med_y
            print(f"\nSuggested --region: 0 {med_y} {w} {med_h}")
            print(f"  → python3 tab_extractor.py <source> -o output.pdf --region 0 {med_y} {w} {med_h}")
        else:
            print("\nCould not auto-detect tab region.")
            print("Open the saved scan_frame_*.jpg files, find where the tab notation is,")
            print("and run with: --region X Y W H  (pixel coordinates of the tab area)")

    finally:
        if tmp_dir:
            import shutil
            shutil.rmtree(tmp_dir, ignore_errors=True)


def extract_tabs_from_video(
    source: str,
    output_pdf: str,
    title: str | None = None,
    tab_region: tuple[int, int, int, int] | None = None,
    sample_interval: float = 0.5,
    keep_video: bool = False,
    min_brightness: float = 140.0,
) -> None:
    """
    Main entry point: download (if URL), extract tabs, generate PDF.

    Args:
        source: YouTube URL or local video file path
        output_pdf: Output PDF path
        title: PDF title (defaults to filename/URL)
        tab_region: Manual (x, y, w, h) crop region; auto-detected if None
        sample_interval: Seconds between sampled frames
        keep_video: Keep downloaded video file
    """
    tmp_dir = None
    video_path = source

    if source.startswith("http://") or source.startswith("https://"):
        tmp_dir = tempfile.mkdtemp(prefix="tab_extract_")
        video_path = download_video(source, tmp_dir)

    if title is None:
        title = Path(video_path).stem

    try:
        frames, offsets = extract_tab_frames(
            video_path,
            tab_region=tab_region,
            sample_interval=sample_interval,
            min_brightness=min_brightness,
        )

        if not frames:
            raise RuntimeError("No tab frames extracted from video")

        stitched = stitch_horizontal(frames, offsets)
        create_pdf(stitched, output_pdf, title=title)

    finally:
        if tmp_dir and not keep_video:
            import shutil
            shutil.rmtree(tmp_dir, ignore_errors=True)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Extract guitar tab notation from a video and generate a PDF.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # From YouTube URL
  python tab_extractor.py https://www.youtube.com/watch?v=XXXX -o output.pdf

  # From local video file
  python tab_extractor.py my_tab_video.mp4 -o tabs.pdf --title "My Song"

  # Specify tab region manually (x y w h in pixels)
  python tab_extractor.py video.mp4 -o tabs.pdf --region 0 400 1920 300

  # Faster extraction (larger interval = fewer frames)
  python tab_extractor.py video.mp4 -o tabs.pdf --interval 1.0
        """,
    )
    parser.add_argument("source", help="YouTube URL or local video file path")
    parser.add_argument("-o", "--output", default="tab_output.pdf", help="Output PDF path (default: tab_output.pdf)")
    parser.add_argument("--title", default=None, help="Title for the PDF")
    parser.add_argument(
        "--region",
        nargs=4,
        type=int,
        metavar=("X", "Y", "W", "H"),
        help="Manual tab region in pixels (x y w h)",
    )
    parser.add_argument(
        "--interval",
        type=float,
        default=0.5,
        help="Frame sampling interval in seconds (default: 0.5)",
    )
    parser.add_argument(
        "--keep-video",
        action="store_true",
        help="Keep downloaded video file after extraction",
    )
    parser.add_argument(
        "--min-brightness",
        type=float,
        default=140.0,
        help=(
            "Minimum mean brightness (0-255) for a frame to be considered tab notation. "
            "Darker frames are skipped as performance video. (default: 140)"
        ),
    )
    parser.add_argument(
        "--scan",
        action="store_true",
        help=(
            "Diagnostic mode: save annotated sample frames to help identify "
            "the correct --region coordinates. No PDF is generated."
        ),
    )

    args = parser.parse_args()
    tab_region = tuple(args.region) if args.region else None

    try:
        if args.scan:
            scan_video(source=args.source, output_dir=".")
        else:
            extract_tabs_from_video(
                source=args.source,
                output_pdf=args.output,
                title=args.title,
                tab_region=tab_region,
                sample_interval=args.interval,
                keep_video=args.keep_video,
                min_brightness=args.min_brightness,
            )
            print("Done!")
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
