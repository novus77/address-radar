import errno
import importlib.util
import os
import pathlib
import tempfile
import unittest
import hashlib

spec = importlib.util.spec_from_file_location('reader', pathlib.Path(__file__).parents[1] / 'preservation-source-reader.py')
reader = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reader)

class ReaderTests(unittest.TestCase):
    def test_identity_contains_all_required_fields(self):
        with tempfile.TemporaryFile() as f:
            before = reader.identity(os.fstat(f.fileno()))
            self.assertEqual(set(before), {'dev', 'ino', 'size', 'mode', 'uid', 'gid', 'mtime_ns', 'ctime_ns'})
            for key in before:
                changed = dict(before); changed[key] += 1
                self.assertFalse(reader.same_identity(before, changed))

    def test_advice_is_only_page_aligned_already_read_range(self):
        calls = []
        self.assertEqual(reader.release_read_pages(4, 0, 7000, lambda *args: calls.append(args), 4096), 'released')
        self.assertEqual(calls, [(4, 0, 4096, reader.DONTNEED)])

    def test_unsupported_advice_is_reported_not_claimed(self):
        def unsupported(*args): raise OSError(errno.ENOSYS, 'unsupported')
        self.assertEqual(reader.release_read_pages(4, 0, 8192, unsupported, 4096), 'unsupported')
        self.assertEqual(reader.release_read_pages(4, 0, 8192, None, 4096), 'unsupported')

    def test_failed_advice_fails_closed(self):
        def failed(*args): raise OSError(errno.EIO, 'failed')
        with self.assertRaisesRegex(RuntimeError, 'source_reader_advice_failed'):
            reader.release_read_pages(4, 0, 8192, failed, 4096)

    def test_corrupt_bytes_do_not_complete(self):
        with tempfile.TemporaryFile() as f:
            f.write(b'corrupt'); f.flush(); f.seek(0)
            with self.assertRaisesRegex(RuntimeError, 'source_reader_digest'):
                reader.stream_fd(f.fileno(), 7, '0' * 64, lambda b: None, lambda: None,
                                 advice=None, sleep=lambda delay: None)

    def test_pressure_stops_before_read(self):
        def pressure(): raise RuntimeError('source_reader_pressure')
        with tempfile.TemporaryFile() as f:
            f.write(b'x'); f.flush(); f.seek(0)
            with self.assertRaisesRegex(RuntimeError, 'source_reader_pressure'):
                reader.stream_fd(f.fileno(), 1, '0' * 64, lambda b: self.fail('emitted'), pressure)

    def test_stream_returns_exact_bytes_and_fresh_digest(self):
        body = bytes(range(256)) * 513
        with tempfile.TemporaryFile() as f:
            f.write(body); f.flush(); f.seek(0)
            chunks = []; calls = []
            result = reader.stream_fd(f.fileno(), len(body), hashlib.sha256(body).hexdigest(), chunks.append,
                                      lambda: None, advice=lambda *args: calls.append(args), sleep=lambda delay: None)
            self.assertEqual(b''.join(chunks), body)
            self.assertTrue(result['freshHash']); self.assertFalse(result['cachedWitnessUsed'])
            self.assertTrue(all(len(chunk) <= 65536 for chunk in chunks))
            self.assertTrue(all(start + length <= len(body) for _, start, length, _ in calls))

    def test_metadata_mutation_during_read_fails(self):
        with tempfile.TemporaryFile() as f:
            f.write(b'x'); f.flush(); f.seek(0)
            def mutate(body): os.fchmod(f.fileno(), 0o640)
            with self.assertRaisesRegex(RuntimeError, 'source_reader_metadata_changed'):
                reader.stream_fd(f.fileno(), 1, hashlib.sha256(b'x').hexdigest(), mutate, lambda: None,
                                 advice=None, sleep=lambda delay: None)

    def test_recent_witness_requires_external_scope_and_exact_identity(self):
        identity = dict.fromkeys(['dev', 'ino', 'size', 'mode', 'uid', 'gid', 'mtime_ns', 'ctime_ns'], 1)
        witness = {'identity': identity, 'sha256': 'a' * 64, 'validatedAtMs': 100, 'complete': True}
        self.assertTrue(reader.recent_witness_matches(witness, identity, 'a' * 64, 200, 'recent-isolated-cached-witness'))
        for scope in [None, 'final-cutover', 'isolated']:
            self.assertFalse(reader.recent_witness_matches(witness, identity, 'a' * 64, 200, scope))
        self.assertFalse(reader.recent_witness_matches(witness, dict(identity, size=2), 'a' * 64, 200, 'recent-isolated-cached-witness'))
        self.assertFalse(reader.recent_witness_matches(witness, identity, 'b' * 64, 200, 'recent-isolated-cached-witness'))
        self.assertFalse(reader.recent_witness_matches(witness, identity, 'a' * 64, 1_000_000, 'recent-isolated-cached-witness'))


class ResourceOptimizationTests(unittest.TestCase):
    def test_no_credit_burst_after_blocked_sink(self):
        raw = b'x' * (reader.BLOCK * 3); now = [0.0]; emitted = [0]; sleeps = []
        def emit(body):
            emitted[0] += 1
            if emitted[0] == 1: now[0] += 1.0
        def sleep(delay): sleeps.append(delay); now[0] += delay
        with tempfile.TemporaryFile() as f:
            f.write(raw); f.flush(); f.seek(0)
            reader.stream_fd(f.fileno(), len(raw), hashlib.sha256(raw).hexdigest(), emit, lambda: None,
                             advice=None, sleep=sleep, clock=lambda: now[0])
        self.assertEqual(len(sleeps), 2)
        for delay in sleeps: self.assertAlmostEqual(delay, reader.BLOCK / reader.RATE)

    def test_write_all_honors_short_writes_and_zero_write_failure(self):
        class SlowSink:
            def __init__(self): self.data = bytearray()
            def write(self, body): self.data.extend(body[:3]); return min(3, len(body))
        sink = SlowSink(); reader.write_all(sink, b'opaque\x00\xff\nbytes')
        self.assertEqual(sink.data, b'opaque\x00\xff\nbytes')
        class StuckSink:
            def write(self, body): return 0
        with self.assertRaisesRegex(RuntimeError, 'source_reader_short_write'):
            reader.write_all(StuckSink(), b'x')

    def test_idle_helper_opens_no_source_and_requires_manifest_request_first(self):
        import io
        def forbidden(name): self.fail('source opened without pinned manifest request')
        reader.serve_requests(io.BytesIO(), io.BytesIO(), forbidden, lambda: None)
        with self.assertRaisesRegex(RuntimeError, 'source_reader_request'):
            reader.serve_requests(io.BytesIO(b'{"file":"table-0000-chunk-000000.json","maximum":10}\n'), io.BytesIO(), forbidden, lambda: None)

    def test_manifest_then_chunk_is_fresh_hashed_once_each_and_no_extra_bootstrap(self):
        import io, json
        from unittest.mock import patch
        chunk = b'opaque\x00\xff\nbytes'; digest = hashlib.sha256(chunk).hexdigest()
        document = json.dumps({'tables':[{'chunks':[{'file':'table-0000-chunk-000000.json','sha256':digest}]}]}).encode()
        document += b' ' * (545010 - len(document))
        with tempfile.TemporaryDirectory() as directory:
            for name, body in [('manifest.json',document),('table-0000-chunk-000000.json',chunk)]:
                with open(os.path.join(directory,name),'wb') as f: f.write(body)
            opened_names=[]; fds=[]
            def opened(name):
                opened_names.append(name); fd=os.open(os.path.join(directory,name),os.O_RDONLY); fds.append(fd)
                return fd,os.fstat(fd)
            requests=b'{"file":"manifest.json","maximum":545010}\n'+b'{"file":"table-0000-chunk-000000.json","maximum":32}\n'
            output=io.BytesIO()
            with patch.object(reader,'MANIFEST_SHA',hashlib.sha256(document).hexdigest()):
                reader.serve_requests(io.BytesIO(requests),output,opened,lambda: None)
            self.assertEqual(opened_names,['manifest.json','table-0000-chunk-000000.json'])
            self.assertIn(chunk,output.getvalue())
            self.assertIn(digest.encode(),output.getvalue())
            for fd in fds:
                with self.assertRaises(OSError): os.fstat(fd)

    def test_repeated_manifest_still_hashes_and_corrupt_chunk_fails(self):
        import io, json
        from unittest.mock import patch
        document=json.dumps({'tables':[{'chunks':[{'file':'table-0000-chunk-000000.json','sha256':hashlib.sha256(b'good').hexdigest()}]}]}).encode()
        document+=b' '*(545010-len(document))
        with tempfile.TemporaryDirectory() as directory:
            with open(os.path.join(directory,'manifest.json'),'wb') as f:f.write(document)
            with open(os.path.join(directory,'table-0000-chunk-000000.json'),'wb') as f:f.write(b'bad!')
            names=[]
            def opened(name):
                names.append(name);fd=os.open(os.path.join(directory,name),os.O_RDONLY);return fd,os.fstat(fd)
            request=b'{"file":"manifest.json","maximum":545010}\n'
            source=io.BytesIO(request+request+b'{"file":"table-0000-chunk-000000.json","maximum":32}\n')
            with patch.object(reader,'MANIFEST_SHA',hashlib.sha256(document).hexdigest()):
                with self.assertRaisesRegex(RuntimeError,'source_reader_digest'):
                    reader.serve_requests(source,io.BytesIO(),opened,lambda:None)
            self.assertEqual(names,['manifest.json','manifest.json','table-0000-chunk-000000.json'])

if __name__ == '__main__': unittest.main()
