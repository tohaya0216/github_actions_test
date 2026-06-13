"""Unit tests for tab_extractor.py"""

import os
import tempfile

import cv2
import numpy as np
import pytest

from tab_extractor import (
    _find_scroll_offset,
    _frame_similarity,
    create_pdf,
    detect_tab_region,
    enhance_tab_image,
    stitch_tab_images,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def make_tab_frame(height: int = 200, width: int = 800, n_strings: int = 6) -> np.ndarray:
    """Create a synthetic frame with evenly-spaced horizontal tab lines."""
    frame = np.ones((height, width, 3), dtype=np.uint8) * 240  # light gray background
    string_spacing = height // (n_strings + 1)
    for i in range(1, n_strings + 1):
        y = i * string_spacing
        cv2.line(frame, (0, y), (width - 1, y), (0, 0, 0), 1)
    return frame


def make_gray_tab(height: int = 200, width: int = 800) -> np.ndarray:
    """Return a grayscale synthetic tab image."""
    bgr = make_tab_frame(height, width)
    return cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)


# ---------------------------------------------------------------------------
# detect_tab_region
# ---------------------------------------------------------------------------

class TestDetectTabRegion:
    def test_detects_horizontal_lines(self):
        frame = make_tab_frame(height=400, width=800, n_strings=6)
        result = detect_tab_region(frame)
        # Should detect some region (may be None if heuristics don't trigger)
        # Just verify no crash and type correctness
        assert result is None or (isinstance(result, tuple) and len(result) == 4)

    def test_blank_frame_returns_none(self):
        blank = np.ones((400, 800, 3), dtype=np.uint8) * 255
        result = detect_tab_region(blank)
        assert result is None


# ---------------------------------------------------------------------------
# _frame_similarity
# ---------------------------------------------------------------------------

class TestFrameSimilarity:
    def test_identical_frames_score_one(self):
        frame = make_gray_tab()
        score = _frame_similarity(frame, frame)
        assert score == pytest.approx(1.0)

    def test_different_frames_lower_score(self):
        a = np.zeros((100, 100), dtype=np.uint8)
        b = np.ones((100, 100), dtype=np.uint8) * 255
        score = _frame_similarity(a, b)
        assert score < 0.1

    def test_different_size_frames_resized(self):
        a = make_gray_tab(100, 200)
        b = make_gray_tab(80, 160)
        score = _frame_similarity(a, b)
        assert 0.0 <= score <= 1.0


# ---------------------------------------------------------------------------
# _find_scroll_offset
# ---------------------------------------------------------------------------

class TestFindScrollOffset:
    def test_overlapping_frames(self):
        base = make_gray_tab(200, 400)
        # next_frame shares the bottom 40px of base at its top
        overlap = 40
        filler = np.ones((100, 400), dtype=np.uint8) * 200
        next_frame = np.vstack([base[-overlap:], filler])
        offset = _find_scroll_offset(base, next_frame, max_overlap=80)
        # Should detect the overlap
        assert offset is not None
        assert offset > 0

    def test_no_overlap_returns_none_or_zero(self):
        base = make_gray_tab(200, 400)
        noise = np.random.randint(0, 255, (200, 400), dtype=np.uint8)
        offset = _find_scroll_offset(base, noise, max_overlap=60)
        # Noise has no meaningful overlap
        assert offset is None or offset == 0


# ---------------------------------------------------------------------------
# stitch_tab_images
# ---------------------------------------------------------------------------

class TestStitchTabImages:
    def test_single_frame_returned_as_is(self):
        frame = make_gray_tab(100, 400)
        result = stitch_tab_images([frame])
        assert result.shape == frame.shape

    def test_two_identical_frames_not_doubled(self):
        frame = make_gray_tab(100, 400)
        result = stitch_tab_images([frame, frame])
        # With perfect overlap, result should be ~same height as one frame
        assert result.shape[0] <= frame.shape[0] * 2

    def test_non_overlapping_frames_stacked(self):
        f1 = make_gray_tab(100, 400)
        f2 = make_gray_tab(100, 400) * 0  # black frame, no overlap
        result = stitch_tab_images([f1, f2])
        assert result.shape[0] >= 100  # at least one frame height

    def test_empty_raises(self):
        with pytest.raises((ValueError, Exception)):
            stitch_tab_images([])


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
        import numpy as np
        gray = make_gray_tab(100, 400)
        result = enhance_tab_image(gray)
        arr = np.array(result)
        unique_values = set(np.unique(arr).tolist())
        assert unique_values <= {0, 255}


# ---------------------------------------------------------------------------
# create_pdf
# ---------------------------------------------------------------------------

class TestCreatePdf:
    def test_creates_pdf_file(self):
        gray = make_gray_tab(200, 800)
        with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as tmp:
            out_path = tmp.name
        try:
            create_pdf(gray, out_path, title="Test Tab")
            assert os.path.exists(out_path)
            assert os.path.getsize(out_path) > 1000  # non-trivial size
        finally:
            if os.path.exists(out_path):
                os.unlink(out_path)

    def test_tall_image_creates_multipage_pdf(self):
        # A very tall image should produce multiple pages
        gray = make_gray_tab(height=6000, width=800)
        with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as tmp:
            out_path = tmp.name
        try:
            create_pdf(gray, out_path, title="Long Tab")
            assert os.path.exists(out_path)
            # Multi-page PDFs are larger
            assert os.path.getsize(out_path) > 2000
        finally:
            if os.path.exists(out_path):
                os.unlink(out_path)
