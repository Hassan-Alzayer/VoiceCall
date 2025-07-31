import numpy as np
from collections import deque
from typing import Deque, Tuple

class RollingWindow:
    """Keep last N seconds of transcript."""
    def __init__(self, max_seconds: float = 6.0):
        self.max_s = max_seconds
        self.buf: Deque[Tuple[str, float]] = deque()

    def add(self, text: str, ts: float) -> str:
        self.buf.append((text, ts))
        while self.buf and ts - self.buf[0][1] > self.max_s:
            self.buf.popleft()
        return " ".join(t for t, _ in self.buf)
