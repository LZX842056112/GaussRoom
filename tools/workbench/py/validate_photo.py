"""Validate original mobile photo bytes without changing the source file."""
import argparse
import hashlib
import json
import subprocess
import sys
import tempfile
import warnings
from pathlib import Path

from PIL import Image, ImageFile, ImageOps

MAX_BYTES = 64 * 1024 * 1024
MAX_PIXELS = 100_000_000
Image.MAX_IMAGE_PIXELS = MAX_PIXELS
ImageFile.LOAD_TRUNCATED_IMAGES = False
FIXTURE = Path(__file__).with_name('photo_fixtures') / 'basic-8bit-srgb.heic'


def inspect_pillow(path, expected=None):
    with warnings.catch_warnings():
        warnings.simplefilter('error', Image.DecompressionBombWarning)
        with Image.open(path) as image:
            if expected and image.format != expected:
                raise ValueError('image format does not match extension')
            if image.width * image.height > MAX_PIXELS:
                raise ValueError('image exceeds pixel limit')
            image.verify()
        with Image.open(path) as image:
            image.load()
            oriented = ImageOps.exif_transpose(image)
            return oriented.size


def check_heif_container(path):
    # Check all top-level box boundaries before invoking a decoder.
    size = path.stat().st_size
    with path.open('rb') as src:
        offset = 0
        brands = set()
        while offset < size:
            src.seek(offset)
            header = src.read(8)
            if len(header) != 8:
                raise ValueError('invalid HEIF container')
            box_size = int.from_bytes(header[:4], 'big')
            head_size = 8
            if box_size == 1:
                extended = src.read(8)
                if len(extended) != 8:
                    raise ValueError('invalid HEIF container')
                box_size = int.from_bytes(extended, 'big')
                head_size = 16
            elif box_size == 0:
                box_size = size - offset
            if box_size < head_size or box_size > size - offset:
                raise ValueError('invalid HEIF container')
            if offset == 0 and header[4:] == b'ftyp' and box_size >= head_size + 8:
                data = src.read(min(box_size - head_size, 4096))
                brands = {data[:4], *(data[i:i+4] for i in range(8, len(data), 4))}
            offset += box_size
        if not brands.intersection({b'heic', b'heix', b'hevc', b'hevx'}):
            raise ValueError('not a HEIC image')


def decode_heif(path, ffmpeg):
    if not ffmpeg:
        raise ValueError('HEIC decoder unavailable')
    check_heif_container(path)
    with tempfile.TemporaryDirectory() as temp:
        decoded = Path(temp) / 'decoded.jpg'
        try:
            result = subprocess.run([str(ffmpeg), '-hide_banner', '-loglevel', 'error', '-xerror',
                                     '-max_pixels', str(MAX_PIXELS), '-i', str(path),
                                     '-frames:v', '1', '-y', str(decoded)],
                                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                    timeout=30, check=False)
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise ValueError('HEIC decoder unavailable') from exc
        if result.returncode or not decoded.is_file() or decoded.stat().st_size > MAX_BYTES:
            raise ValueError('HEIC decode failed')
        return inspect_pillow(decoded, 'JPEG')


def capabilities(ffmpeg):
    formats = ['.jpg', '.jpeg', '.png']
    try:
        if decode_heif(FIXTURE, ffmpeg) == (1600, 1200):
            formats.extend(['.heic', '.heif'])
    except (OSError, ValueError, SyntaxError):
        pass
    return {'photoFormats': formats}


def hash_file(path):
    digest = hashlib.sha256()
    with path.open('rb') as src:
        while block := src.read(1024 * 1024):
            digest.update(block)
    return digest.hexdigest()


def validate(path, extension, minimum, ffmpeg):
    extension = extension.lower()
    if extension not in ('.jpg', '.jpeg', '.png', '.heic', '.heif'):
        raise ValueError('unsupported image extension')
    size = path.stat().st_size
    if size == 0 or size > MAX_BYTES:
        raise ValueError('invalid image size')
    digest = hash_file(path)
    if extension in ('.heic', '.heif'):
        width, height = decode_heif(path, ffmpeg)
        fmt = extension[1:].upper()
    else:
        fmt = 'PNG' if extension == '.png' else 'JPEG'
        width, height = inspect_pillow(path, fmt)
        extension = '.png' if fmt == 'PNG' else '.jpg'
    if max(width, height) < minimum:
        raise ValueError('image resolution is too small')
    if path.stat().st_size != size or hash_file(path) != digest:
        raise ValueError('image changed during validation')
    return {'format': fmt, 'extension': extension, 'width': width, 'height': height,
            'sha256': digest, 'bytes': size}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--capabilities', action='store_true')
    parser.add_argument('--image', type=Path)
    parser.add_argument('--extension')
    parser.add_argument('--min-long-edge', type=int, default=1000)
    parser.add_argument('--ffmpeg')
    args = parser.parse_args()
    try:
        if args.capabilities:
            result = capabilities(args.ffmpeg)
        elif args.image and args.extension and args.min_long_edge >= 1000:
            result = validate(args.image, args.extension, args.min_long_edge, args.ffmpeg)
        else:
            raise ValueError('image, extension and valid minimum are required')
        print(json.dumps(result))
    except Exception:
        print('Invalid photo or unsupported decoder', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
