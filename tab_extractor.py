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

    Strategy: Tab notation typically contains horizontal lines (strings)
    arranged in groups of 6 (standard guitar) or 4 (bass).
    We look for regions with dense, evenly-spaced horizontal lines.
    """
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    h, w = gray.shape

    # Detect horizontal lines using morphological operations
    kernel_h = cv2.getStructuringElement(cv2.MORPH_RECT, (w // 8, 1))
    horizontal = cv2.morphologyEx(gray, cv2.MORPH_OPEN, kernel_h)

    # Threshold
    _, binary = cv2.threshold(horizontal, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)

    # Find rows with significant horizontal content
    row_density = np.sum(binary == 255, axis=1) / w

    # Look for bands of 4 or 6 evenly-spaced lines (tab strings)
    threshold = 0.3
    line_rows = np.where(row_density > threshold)[0]
    if len(line_rows) < 4:
        return None

    # Find contiguous groups of line rows
    groups = []
    if len(line_rows) > 0:
        group_start = line_rows[0]
        prev = line_rows[0]
        for r in line_rows[1:]:
            if r - prev > h // 20:
                groups.append((group_start, prev))
                group_start = r
            prev = r
        groups.append((group_start, prev))

    if not groups:
        return None

    # Find the largest vertical span that contains tab lines
    top = min(g[0] for g in groups)
    bottom = max(g[1] for g in groups)

    # Add padding
    pad = int(h * 0.02)
    top = max(0, top - pad)
    bottom = min(h - 1, bottom + pad)

    region_height = bottom - top
    if region_height < h * 0.05:
        return None

    return (0, top, w, region_height)


def extract_tab_frames(
    video_path: str,
    tab_region: tuple[int, int, int, int] | None = None,
    sample_interval: float = 0.5,
    similarity_threshold: float = 0.97,
) -> list[np.ndarray]:
    """
    Extract unique tab frames from video.

    Args:
        video_path: Path to the video file
        tab_region: (x, y, w, h) of the tab region, auto-detected if None
        sample_interval: Seconds between frame samples
        similarity_threshold: Frames more similar than this are considered duplicates

    Returns:
        List of unique tab region images (grayscale)
    """
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        raise RuntimeError(f"Cannot open video: {video_path}")

    fps = cap.get(cv2.CAP_PROP_FPS)
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    frame_step = max(1, int(fps * sample_interval))
    duration = total_frames / fps

    print(f"Video: {duration:.1f}s, {fps:.1f}fps, sampling every {sample_interval}s")

    # Auto-detect tab region from early frames if not provided
    if tab_region is None:
        print("Auto-detecting tab region...")
        tab_region = _auto_detect_region(cap, fps, total_frames)
        if tab_region:
            x, y, w, h = tab_region
            print(f"Detected tab region: x={x}, y={y}, w={w}, h={h}")
        else:
            print("Could not auto-detect tab region, using full frame")

    unique_frames = []
    last_frame_hash = None
    frame_idx = 0

    while True:
        cap.set(cv2.CAP_PROP_POS_FRAMES, frame_idx)
        ret, frame = cap.read()
        if not ret:
            break

        # Crop to tab region
        if tab_region:
            x, y, w, h = tab_region
            roi = frame[y:y + h, x:x + w]
        else:
            roi = frame

        gray = cv2.cvtColor(roi, cv2.COLOR_BGR2GRAY)

        # Compare with last unique frame
        if last_frame_hash is not None:
            if last_frame_hash.shape == gray.shape:
                sim = _frame_similarity(last_frame_hash, gray)
                if sim > similarity_threshold:
                    frame_idx += frame_step
                    continue

        unique_frames.append(gray.copy())
        last_frame_hash = gray.copy()

        progress = frame_idx / total_frames * 100
        print(f"\r  Extracting frames: {progress:.1f}% ({len(unique_frames)} unique)", end="", flush=True)

        frame_idx += frame_step

    cap.release()
    print(f"\nExtracted {len(unique_frames)} unique tab frames")
    return unique_frames


def _auto_detect_region(
    cap: cv2.VideoCapture, fps: float, total_frames: int
) -> tuple[int, int, int, int] | None:
    """Sample a few frames to auto-detect the tab region."""
    sample_positions = [
        int(total_frames * 0.2),
        int(total_frames * 0.4),
        int(total_frames * 0.6),
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

    # Use median region
    tops = sorted(c[1] for c in candidates)
    bottoms = sorted(c[1] + c[3] for c in candidates)
    median_top = tops[len(tops) // 2]
    median_bottom = bottoms[len(bottoms) // 2]
    width = candidates[0][2]

    return (0, median_top, width, median_bottom - median_top)


def _frame_similarity(a: np.ndarray, b: np.ndarray) -> float:
    """Compute structural similarity between two grayscale frames (0-1)."""
    if a.shape != b.shape:
        b = cv2.resize(b, (a.shape[1], a.shape[0]))
    diff = cv2.absdiff(a, b)
    return 1.0 - (np.mean(diff) / 255.0)


def stitch_tab_images(
    frames: list[np.ndarray],
    overlap_px: int = 60,
) -> np.ndarray:
    """
    Stitch tab frames into a single long image.
    Handles scrolling tabs by finding the overlap between consecutive frames.
    """
    if not frames:
        raise ValueError("No frames to stitch")
    if len(frames) == 1:
        return frames[0]

    print("Stitching frames...")
    result = frames[0].copy()

    for i, frame in enumerate(frames[1:], 1):
        print(f"\r  Stitching: {i}/{len(frames)-1}", end="", flush=True)

        # Find vertical scroll offset between result's bottom and this frame's top
        offset = _find_scroll_offset(result, frame, overlap_px)

        if offset is None or offset <= 0:
            # No overlap found — append directly
            result = np.vstack([result, frame])
        else:
            # Append only the new (non-overlapping) portion
            new_content = frame[offset:]
            if new_content.shape[0] > 0:
                result = np.vstack([result, new_content])

    print(f"\nStitched image size: {result.shape[1]}x{result.shape[0]}px")
    return result


def _find_scroll_offset(base: np.ndarray, next_frame: np.ndarray, max_overlap: int) -> int | None:
    """
    Find how many rows from the top of next_frame overlap with the bottom of base.
    Returns the number of rows to skip in next_frame (the overlap height).
    """
    search_h = min(max_overlap, base.shape[0], next_frame.shape[0])
    w = min(base.shape[1], next_frame.shape[1])

    base_bottom = base[-search_h:, :w].astype(np.float32)
    best_score = -1
    best_offset = 0

    for offset in range(4, search_h):
        candidate = next_frame[:offset, :w].astype(np.float32)
        if candidate.shape[0] == 0:
            continue
        # Scale base_bottom slice to same height as candidate
        base_slice = cv2.resize(base_bottom[-offset:], (w, offset))
        diff = np.mean(np.abs(base_slice - candidate))
        score = 1.0 - diff / 255.0
        if score > best_score:
            best_score = score
            best_offset = offset

    if best_score > 0.85:
        return best_offset
    return None


def enhance_tab_image(img: np.ndarray) -> Image.Image:
    """Enhance tab image for clean PDF output."""
    pil_img = Image.fromarray(img)

    # Increase contrast
    enhancer = ImageEnhance.Contrast(pil_img)
    pil_img = enhancer.enhance(2.0)

    # Sharpen
    pil_img = pil_img.filter(ImageFilter.SHARPEN)

    # Binarize for crisp lines
    gray_arr = np.array(pil_img)
    _, binary = cv2.threshold(gray_arr, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    return Image.fromarray(binary)


def create_pdf(
    tab_image: np.ndarray,
    output_path: str,
    title: str = "Guitar Tab",
    margin_mm: float = 15.0,
) -> None:
    """
    Render the stitched tab image onto A4 pages and save as PDF.
    """
    pil_tab = enhance_tab_image(tab_image)
    tab_w, tab_h = pil_tab.size

    page_w, page_h = A4  # points (595.27 x 841.89)
    margin = margin_mm * mm
    content_w = page_w - 2 * margin
    content_h = page_h - 2 * margin

    # Scale tab image width to fit content area
    scale = content_w / tab_w
    scaled_tab_h = int(tab_h * scale)
    scaled_tab_w = int(content_w)

    pil_tab = pil_tab.resize((scaled_tab_w, scaled_tab_h), Image.LANCZOS)

    # Split into page-sized strips
    strip_h_px = int(content_h / scale * (scaled_tab_h / tab_h))
    # strip height in pixels at the scaled resolution
    strip_h_px = int(content_h / (page_h / scaled_tab_h)) if scaled_tab_h > 0 else scaled_tab_h

    # Recalculate: how many pixels fit per page
    px_per_page = int(content_h * (tab_h / (scaled_tab_h if scaled_tab_h > 0 else tab_h)))
    # Simpler: just use content_h in points converted to pixels
    px_per_page = int(content_h / scale) if scale > 0 else tab_h

    strips = []
    y = 0
    while y < tab_h:
        strip = pil_tab.crop((0, int(y * scale), scaled_tab_w, int(min((y + px_per_page) * scale, scaled_tab_h))))
        if strip.size[1] > 0:
            strips.append(strip)
        y += px_per_page

    print(f"Generating PDF: {len(strips)} page(s) → {output_path}")

    c = canvas.Canvas(output_path, pagesize=A4)

    for page_num, strip in enumerate(strips):
        if page_num > 0:
            c.showPage()

        # Title on first page
        if page_num == 0:
            c.setFont("Helvetica-Bold", 14)
            c.drawString(margin, page_h - margin + 5 * mm, title)

        # Save strip as temp image
        with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as tmp:
            tmp_path = tmp.name
        strip.save(tmp_path, "PNG")

        strip_w_pt, strip_h_pt = (content_w, strip.size[1] * scale)
        # Clamp to content height
        draw_h = min(strip_h_pt, content_h)

        c.drawImage(
            tmp_path,
            margin,
            page_h - margin - draw_h,
            width=content_w,
            height=draw_h,
            preserveAspectRatio=False,
        )
        os.unlink(tmp_path)

        # Page number
        c.setFont("Helvetica", 9)
        c.drawCentredString(page_w / 2, margin / 2, str(page_num + 1))

    c.save()
    print(f"PDF saved: {output_path}")


def extract_tabs_from_video(
    source: str,
    output_pdf: str,
    title: str | None = None,
    tab_region: tuple[int, int, int, int] | None = None,
    sample_interval: float = 0.5,
    keep_video: bool = False,
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

    if title is None:
        title = Path(video_path).stem

    try:
        frames = extract_tab_frames(
            video_path,
            tab_region=tab_region,
            sample_interval=sample_interval,
        )

        if not frames:
            raise RuntimeError("No tab frames extracted from video")

        stitched = stitch_tab_images(frames)
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

  # Specify tab region manually (x y w h)
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

    args = parser.parse_args()

    tab_region = tuple(args.region) if args.region else None

    try:
        extract_tabs_from_video(
            source=args.source,
            output_pdf=args.output,
            title=args.title,
            tab_region=tab_region,
            sample_interval=args.interval,
            keep_video=args.keep_video,
        )
        print("Done!")
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
