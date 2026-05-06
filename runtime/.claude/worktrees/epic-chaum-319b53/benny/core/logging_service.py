import logging
import datetime
from collections import deque
from typing import List, Dict

class BufferedLogHandler(logging.Handler):
    """
    Cognitive Mesh In-Memory Log Buffer.
    Captures logs from the standard logging module and keeps them in a rolling queue.
    """
    def __init__(self, capacity: int = 100):
        super().__init__()
        self.buffer = deque(maxlen=capacity)
        self.capacity = capacity

    def emit(self, record):
        try:
            msg = self.format(record)
            log_entry = {
                "id": f"{record.created:.6f}",
                "timestamp": datetime.datetime.fromtimestamp(record.created).isoformat(),
                "level": record.levelname,
                "module": record.module,
                "message": msg,
                "type": "log"
            }
            self.buffer.append(log_entry)
        except Exception:
            self.handleError(record)

    def get_logs(self) -> List[Dict]:
        return list(self.buffer)

# Global instances for the API to access
system_logs = BufferedLogHandler(capacity=100)
# Simple formatter
system_logs.setFormatter(logging.Formatter('%(message)s'))
