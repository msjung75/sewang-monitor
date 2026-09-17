"""CI HTTPS transport. Credentials enter through stdin and never appear in logs.

urllib honors the runner's configured HTTPS proxy and certificate verification.
The government response is returned only to the parent collector, not CI stdout.
"""
import json
import socket
import ssl
import sys
import urllib.error
import urllib.parse
import urllib.request

MAX_BYTES = 4 * 1024 * 1024


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def main():
    request = json.load(sys.stdin)
    url = request['url']
    parsed = urllib.parse.urlsplit(url)
    if (parsed.scheme != 'https' or parsed.hostname != 'apis.data.go.kr'
            or parsed.port not in (None, 443) or parsed.username or parsed.password
            or not parsed.path.startswith('/1741000/')):
        raise ValueError('invalid_target')
    opener = urllib.request.build_opener(NoRedirect())
    req = urllib.request.Request(url, headers={'Accept': 'application/json'})
    try:
        response = opener.open(req, timeout=40)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        body = response.read(MAX_BYTES + 1)
        if len(body) > MAX_BYTES:
            raise ValueError('response_too_large')
        return {'status': response.code, 'body': body.decode('utf-8-sig')}


if __name__ == '__main__':
    try:
        result = main()
    except Exception as error:
        cause = getattr(error, 'reason', error)
        if isinstance(cause, (TimeoutError, socket.timeout)):
            code = 'upstream_timeout'
        elif isinstance(cause, ssl.SSLError):
            code = 'upstream_tls_failed'
        elif isinstance(cause, socket.gaierror):
            code = 'upstream_dns_failed'
        else:
            code = 'upstream_connection_failed'
        result = {'error': code}
    json.dump(result, sys.stdout, ensure_ascii=False)
