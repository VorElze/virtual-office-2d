import os
import ssl
from http.server import ThreadingHTTPServer

from server import Handler

PORT = int(os.environ.get("PORT", "8765"))
CERT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "certs")

context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
context.load_cert_chain(os.path.join(CERT_DIR, "server.crt"),
                        os.path.join(CERT_DIR, "server.key"))

srv = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
srv.socket = context.wrap_socket(srv.socket, server_side=True)
print("PixelOffice HTTPS server on https://0.0.0.0:%d" % PORT, flush=True)
srv.serve_forever()
