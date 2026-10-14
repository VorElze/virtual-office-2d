import os
import ssl
from http.server import ThreadingHTTPServer

from server import Handler

PORT = int(os.environ.get("PORT", "8765"))
CERT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "certs")

context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
context.load_cert_chain(os.path.join(CERT_DIR, "server.crt"),
                        os.path.join(CERT_DIR, "server.key"))


class TLSThreadedHTTPServer(ThreadingHTTPServer):
    """ThreadingHTTPServer dengan TLS handshake di THREAD PEKERJA,
    bukan di loop accept.

    Bug lama: srv.socket = context.wrap_socket(...) -> handshake jalan di
    thread utama accept. Satu koneksi klien yang stall (browser HP mati di
    tengah handshake) memblokir accept seluruhnya -> backlog penuh -> 503
    padahal service "active". Terbukti 13 Okt 20:05 WIB.
    """
    daemon_threads = True
    request_queue_size = 128          # backlog besar (lama: 5, gampang penuh)
    handshake_timeout = 10            # detik: handshake lambat dibuang

    def process_request_thread(self, request, client_address):
        try:
            request.settimeout(self.handshake_timeout)
            tls = context.wrap_socket(request, server_side=True)
        except Exception:
            # klien macet/timeout saat handshake -> tutup, terima klien lain
            try:
                self.shutdown_request(request)
            except Exception:
                pass
            return
        tls.settimeout(getattr(Handler, "timeout", 30))   # batas baca per request
        try:
            self.finish_request(tls, client_address)
        except Exception:
            self.handle_error(tls, client_address)
        finally:
            try:
                self.shutdown_request(tls)
            except Exception:
                pass


srv = TLSThreadedHTTPServer(("0.0.0.0", PORT), Handler)
# Listening socket TIDAK di-wrap: accept murni TCP, handshake di worker thread.
print("PixelOffice HTTPS server on https://0.0.0.0:%d" % PORT, flush=True)
srv.serve_forever()
