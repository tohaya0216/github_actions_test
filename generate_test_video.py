"""Generate a synthetic guitar tab video for testing tab_extractor.py"""

import cv2
import numpy as np
import os

def make_tab_frame(frame_num: int, total_frames: int, width=1280, height=720) -> np.ndarray:
    """Render a single frame with scrolling guitar tab notation."""
    img = np.ones((height, width, 3), dtype=np.uint8) * 245  # off-white bg

    # ---- Tab region: bottom 40% of frame ----
    tab_top = int(height * 0.55)
    tab_h = int(height * 0.38)

    # Background for tab area
    cv2.rectangle(img, (0, tab_top - 10), (width, tab_top + tab_h + 10), (255, 255, 255), -1)
    cv2.rectangle(img, (0, tab_top - 10), (width, tab_top + tab_h + 10), (180, 180, 180), 2)

    # Label: "TAB"
    cv2.putText(img, "TAB", (10, tab_top + 30), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (100, 100, 100), 2)

    # 6 guitar strings (horizontal lines)
    n_strings = 6
    string_labels = ["e", "B", "G", "D", "A", "E"]
    string_spacing = tab_h // (n_strings + 1)
    string_y = [tab_top + string_spacing * (i + 1) for i in range(n_strings)]

    for i, y in enumerate(string_y):
        cv2.line(img, (40, y), (width - 20, y), (60, 60, 60), 1)
        cv2.putText(img, string_labels[i], (15, y + 5),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.5, (80, 80, 80), 1)

    # ---- Scrolling fret numbers ----
    # The tab "scrolls" left as the video progresses
    scroll_speed = 3  # pixels per frame
    x_offset = width - frame_num * scroll_speed

    # Define a repeating tab pattern (chord progression: G - C - D - Em)
    pattern = [
        # (string_index, fret, x_pos_in_pattern)
        # G chord
        (0, 3, 0),   (1, 0, 0),   (2, 0, 0),   (3, 0, 0),   (4, 2, 0),   (5, 3, 0),
        # C chord
        (0, 0, 120), (1, 1, 120), (2, 0, 120), (3, 2, 120), (4, 3, 120), (5, 0, 120),
        # D chord
        (0, 2, 240), (1, 3, 240), (2, 2, 240), (3, 0, 240), (4, 0, 240), (5, 0, 240),
        # Em chord
        (0, 0, 360), (1, 0, 360), (2, 0, 360), (3, 2, 360), (4, 2, 360), (5, 0, 360),
        # repeat
        (0, 3, 480), (1, 0, 480), (2, 0, 480), (3, 0, 480), (4, 2, 480), (5, 3, 480),
        (0, 0, 600), (1, 1, 600), (2, 0, 600), (3, 2, 600), (4, 3, 600), (5, 0, 600),
        (0, 2, 720), (1, 3, 720), (2, 2, 720), (3, 0, 720), (4, 0, 720), (5, 0, 720),
        (0, 0, 840), (1, 0, 840), (2, 0, 840), (3, 2, 840), (4, 2, 840), (5, 0, 840),
    ]

    for tile in range(4):  # repeat the pattern across the screen
        tile_offset = tile * 960
        for (string_idx, fret, pat_x) in pattern:
            x = x_offset + tile_offset + pat_x
            if -30 < x < width:
                y = string_y[string_idx]
                text = str(fret)
                # White background behind number
                (tw, th), _ = cv2.getTextSize(text, cv2.FONT_HERSHEY_SIMPLEX, 0.55, 2)
                cv2.rectangle(img, (x - 2, y - th - 2), (x + tw + 2, y + 4), (255, 255, 255), -1)
                cv2.putText(img, text, (x, y + 2),
                            cv2.FONT_HERSHEY_SIMPLEX, 0.55, (20, 20, 20), 2)

    # ---- Upper half: fake video content (guitar image simulation) ----
    # Solid dark background (no horizontal lines that would confuse tab detection)
    cv2.rectangle(img, (0, 0), (width, tab_top - 10), (40, 55, 70), -1)
    # Add some visual noise to make it look like a real video frame
    noise_region = np.random.randint(30, 90, (tab_top - 10, width, 3), dtype=np.uint8)
    img[:tab_top - 10] = noise_region

    cv2.putText(img, "Guitar Performance Video", (width // 2 - 200, tab_top // 2),
                cv2.FONT_HERSHEY_SIMPLEX, 1.0, (220, 220, 220), 2)

    # Progress indicator
    progress = frame_num / total_frames
    bar_w = int(width * progress)
    cv2.rectangle(img, (0, height - 8), (bar_w, height), (0, 180, 80), -1)
    cv2.rectangle(img, (0, height - 8), (width, height), (120, 120, 120), 1)

    return img


def generate_test_video(output_path: str = "test_tab_video.mp4",
                         duration_sec: int = 15,
                         fps: int = 30) -> str:
    total_frames = duration_sec * fps
    fourcc = cv2.VideoWriter_fourcc(*"mp4v")
    writer = cv2.VideoWriter(output_path, fourcc, fps, (1280, 720))

    print(f"Generating {duration_sec}s test video ({total_frames} frames)...")
    for i in range(total_frames):
        frame = make_tab_frame(i, total_frames)
        writer.write(frame)
        if i % 60 == 0:
            print(f"  {i}/{total_frames} frames", end="\r", flush=True)

    writer.release()
    size_mb = os.path.getsize(output_path) / 1e6
    print(f"\nGenerated: {output_path} ({size_mb:.1f} MB)")
    return output_path


if __name__ == "__main__":
    generate_test_video()
