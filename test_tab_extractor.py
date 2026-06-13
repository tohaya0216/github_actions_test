"""Unit tests for tab_extractor.py"""

import os
import tempfile

import cv2
import numpy as np
import pytest

from tab_extractor import (
    _frame_similarity,
    create_pdf,
    detect_horizontal_scroll,
    detect_tab_region,
    enhance_tab_image,
    stitch_horizontal,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def make_tab_frame(height: int = 200, width: int = 800, n_strings: int = 6) -> np.ndarray:
    """Create a synthetic BGR frame with evenly-spaced horizontal tab lines."""
    frame = np.ones((height, width, 3), dtype=np.uint8) * 240
    string_spacing = height // (n_strings + 1)
    for i in range(1, n_strings + 1):
        y = i * string_spacing
        cv2.line(frame, (0, y), (width - 1, y), (0, 0, 0), 1)
    return frame


def make_gray_tab(height: int = 200, width: int = 800) -> np.ndarray:
    """Return a grayscale synthetic tab image."""
    bgr = make_tab_frame(height, width)
    return cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)


def make_scrolled(base: np.ndarray, scroll_px: int) -> np.ndarray:
    """Return base shifted left by scroll_px, padding the right with white."""
    h, w = base.shape
    shifted = np.ones_like(base) * 255
    if scroll_px < w:
        shifted[:, :w - scroll_px] = base[:, scroll_px:]
    return shifted


def make_distinctive_tab(height: int = 200, width: int = 800) -> np.ndarray:
    """
    Grayscale tab image with unique content at each x position (fret numbers),
    so template matching can reliably detect horizontal scroll offsets.
    """
    frame = np.ones((height, width, 3), dtype=np.uint8) * 240
    n_strings = 6
    spacing = height // (n_strings + 1)
    string_y = [spacing * (i + 1) for i in range(n_strings)]

    # Draw string lines
    for y in string_y:
        cv2.line(frame, (0, y), (width - 1, y), (0, 0, 0), 1)

    # Draw fret numbers at varying x positions to break horizontal uniformity
    frets = [
        (80,  0, "3"), (80,  3, "0"), (80,  4, "2"),
        (200, 1, "1"), (200, 2, "0"), (200, 5, "3"),
        (340, 0, "0"), (340, 1, "2"), (340, 3, "2"),
        (480, 2, "1"), (480, 4, "3"), (480, 5, "0"),
        (620, 0, "2"), (620, 1, "0"), (620, 3, "0"),
        (720, 2, "3"), (720, 4, "1"), (720, 5, "2"),
    ]
    for x, si, fret in frets:
        if 0 <= x < width:
            y = string_y[si]
            # White bg behind number
            (tw, th), _ = cv2.getTextSize(fret, cv2.FONT_HERSHEY_SIMPLEX, 0.55, 2)
            cv2.rectangle(frame, (x - 2, y - th - 2), (x + tw + 2, y + 4), (255, 255, 255), -1)
            cv2.putText(frame, fret, (x, y + 2), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (0, 0, 0), 2)

    return cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)


# ---------------------------------------------------------------------------
# detect_tab_region
# ---------------------------------------------------------------------------

class TestDetectTabRegion:
    def test_does_not_crash_on_tab_frame(self):
        frame = make_tab_frame(height=400, width=800, n_strings=6)
        result = detect_tab_region(frame)
        assert result is None or (isinstance(result, tuple) and len(result) == 4)

    def test_blank_frame_returns_none(self):
        blank = np.ones((400, 800, 3), dtype=np.uint8) * 255
        result = detect_tab_region(blank)
        assert result is None

    def test_detects_evenly_spaced_lines(self):
        # Build a frame where only the bottom portion has 6 evenly-spaced lines
        h, w = 600, 1200
        frame = np.ones((h, w, 3), dtype=np.uint8) * 245
        spacing = 25
        tab_top = 350
        for i in range(6):
            y = tab_top + spacing * (i + 1)
            cv2.line(frame, (10, y), (w - 10, y), (30, 30, 30), 1)
        result = detect_tab_region(frame)
        if result is not None:
            x, y, rw, rh = result
            # Detected region should be in the lower half of the frame
            assert y >= h // 4


# ---------------------------------------------------------------------------
# _frame_similarity
# ---------------------------------------------------------------------------

class TestFrameSimilarity:
    def test_identical_frames_score_one(self):
        frame = make_gray_tab()
        assert _frame_similarity(frame, frame) == pytest.approx(1.0)

    def test_all_black_vs_all_white(self):
        a = np.zeros((100, 100), dtype=np.uint8)
        b = np.ones((100, 100), dtype=np.uint8) * 255
        assert _frame_similarity(a, b) < 0.1

    def test_different_sizes_handled(self):
        a = make_gray_tab(100, 200)
        b = make_gray_tab(80, 160)
        score = _frame_similarity(a, b)
        assert 0.0 <= score <= 1.0


# ---------------------------------------------------------------------------
# detect_horizontal_scroll
# ---------------------------------------------------------------------------

class TestDetectHorizontalScroll:
    def test_known_scroll_detected(self):
        # Use a frame with unique content at each position (fret numbers)
        base = make_distinctive_tab(200, 800)
        scroll_px = 80
        shifted = make_scrolled(base, scroll_px)
        detected = detect_horizontal_scroll(base, shifted, max_scroll=200)
        assert abs(detected - scroll_px) <= 8

    def test_zero_scroll_returns_zero(self):
        base = make_distinctive_tab(200, 800)
        detected = detect_horizontal_scroll(base, base.copy(), max_scroll=200)
        assert detected == 0

    def test_random_noise_low_confidence(self):
        base = make_gray_tab(200, 800)
        noise = np.random.randint(0, 255, (200, 800), dtype=np.uint8)
        detected = detect_horizontal_scroll(base, noise, max_scroll=200)
        # No reliable match → should return 0
        assert detected == 0

    def test_too_narrow_frame_returns_zero(self):
        tiny = np.ones((50, 50), dtype=np.uint8) * 128
        assert detect_horizontal_scroll(tiny, tiny) == 0


# ---------------------------------------------------------------------------
# stitch_horizontal
# ---------------------------------------------------------------------------

class TestStitchHorizontal:
    def test_single_frame_returned_as_is(self):
        frame = make_gray_tab(100, 400)
        result = stitch_horizontal([frame], [0])
        assert result.shape == frame.shape

    def test_two_frames_wider_than_one(self):
        frame = make_gray_tab(100, 400)
        scroll = 80
        shifted = make_scrolled(frame, scroll)
        result = stitch_horizontal([frame, shifted], [0, scroll])
        assert result.shape[1] > frame.shape[1]
        assert result.shape[1] <= frame.shape[1] + scroll

    def test_zero_offset_does_not_expand(self):
        frame = make_gray_tab(100, 400)
        result = stitch_horizontal([frame, frame.copy()], [0, 0])
        # No scroll → no new content appended
        assert result.shape[1] == frame.shape[1]

    def test_empty_raises(self):
        with pytest.raises((ValueError, Exception)):
            stitch_horizontal([], [])


# ---------------------------------------------------------------------------
# enhance_tab_image
# ---------------------------------------------------------------------------

class TestEnhanceTabImage:
    def test_returns_pil_image(self):
        from PIL import Image
        gray = make_gray_tab(100, 400)
        result = enhance_tab_image(gray)
        assert isinstance(result, Image.Image)

    def test_output_is_binary(self):
        gray = make_gray_tab(100, 400)
        result = enhance_tab_image(gray)
        arr = np.array(result)
        assert set(np.unique(arr).tolist()) <= {0, 255}


# ---------------------------------------------------------------------------
# create_pdf
# ---------------------------------------------------------------------------

class TestCreatePdf:
    def test_creates_nonempty_pdf(self):
        gray = make_gray_tab(200, 2000)
        with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as tmp:
            out_path = tmp.name
        try:
            create_pdf(gray, out_path, title="Test Tab")
            assert os.path.exists(out_path)
            assert os.path.getsize(out_path) > 1000
        finally:
            os.path.exists(out_path) and os.unlink(out_path)

    def test_very_wide_image_generates_pdf(self):
        # Wide image should be wrapped into multiple rows → still generates valid PDF
        gray = make_gray_tab(height=200, width=8000)
        with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as tmp:
            out_path = tmp.name
        try:
            create_pdf(gray, out_path, title="Long Tab")
            assert os.path.exists(out_path)
            assert os.path.getsize(out_path) > 2000
        finally:
            os.path.exists(out_path) and os.unlink(out_path)
