# Breaking News Archive

A single-file browser app that scans five independent breaking-news feeds by default, compares the top 10 normalized stories against a configurable p2fk keyword, and etches only the missing stories one at a time after each prior transaction fully confirms. Story deduplication now uses a stable URL-hash identifier instead of Google GUID extraction, and the app is designed to run directly from `file://` in a modern browser.

All Mempool requests in a page share a queue: at most 10 attempts start in a burst, followed by a 10-second pause. HTTP 429 pauses the queue for at least 10 seconds, or longer if `Retry-After` is available. The configured Mempool API is tried first; on a 10-second timeout, network failure, HTTP 408, or server error, requests rotate through 47 regional Mempool hosts using their Testnet3 APIs. The last selected host is preferred until the configured API changes or another failover is needed. Each open page has its own queue.
