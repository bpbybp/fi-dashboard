"""로컬 개발 서버 — `python -m http.server` 와 같되 모든 응답에 Cache-Control: no-store.

개발 전용. 배포(GitHub Pages)에는 영향 없음.
data/*.js 갱신이나 js 모듈 수정 후 브라우저가 옛 파일을 캐시로 쓰던 문제 방지(docs/BACKLOG.md).

사용: python tools/dev-server.py [port]   (기본 8000, 127.0.0.1 바인드, 레포 루트 서빙)
"""
import functools
import http.server
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent


class NoStoreHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    handler = functools.partial(NoStoreHandler, directory=str(ROOT))
    with http.server.ThreadingHTTPServer(("127.0.0.1", port), handler) as httpd:
        print(f"dev-server (no-store): http://127.0.0.1:{port}/  root={ROOT}")
        httpd.serve_forever()


if __name__ == "__main__":
    main()
