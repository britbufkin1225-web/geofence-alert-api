import { BadRequestException } from '@nestjs/common';

import { ParseCuidPipe } from './parse-cuid.pipe';

describe('ParseCuidPipe', () => {
  const pipe = new ParseCuidPipe();

  it('returns a syntactically valid cuid unchanged', () => {
    const id = 'cjld2cjxh0000qzrmn831i7rn';
    expect(pipe.transform(id)).toBe(id);
  });

  it('rejects a malformed identifier', () => {
    expect(() => pipe.transform('not-a-cuid')).toThrow(BadRequestException);
  });

  it('rejects an empty identifier', () => {
    expect(() => pipe.transform('')).toThrow(BadRequestException);
  });

  it('rejects an identifier of the wrong length', () => {
    expect(() => pipe.transform('c123')).toThrow(BadRequestException);
  });

  it('rejects an identifier with uppercase characters', () => {
    expect(() => pipe.transform('cJLD2CJXH0000QZRMN831I7RN')).toThrow(
      BadRequestException,
    );
  });
});
