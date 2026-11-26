import { describe, expect, it } from 'vitest';

import { folderUrl, myDriveUrl, parseDocUrl } from '@/lib/docs-url';

const ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz_0123456789-ab';

describe('parseDocUrl', () => {
  it('reads Docs, Sheets and Slides addresses', () => {
    expect(parseDocUrl(`https://docs.google.com/document/d/${ID}/edit`)).toEqual({
      kind: 'document',
      fileId: ID,
    });
    expect(parseDocUrl(`https://docs.google.com/spreadsheets/d/${ID}/edit#gid=0`)).toEqual({
      kind: 'spreadsheets',
      fileId: ID,
    });
    expect(parseDocUrl(`https://docs.google.com/presentation/d/${ID}/edit?slide=id.p`)).toEqual({
      kind: 'presentation',
      fileId: ID,
    });
  });

  it('keeps the /u/<n>/ account index', () => {
    expect(parseDocUrl(`https://docs.google.com/document/u/1/d/${ID}/edit`)).toEqual({
      kind: 'document',
      fileId: ID,
      accountIndex: 1,
    });
    expect(parseDocUrl(`https://docs.google.com/spreadsheets/u/12/d/${ID}`)).toEqual({
      kind: 'spreadsheets',
      fileId: ID,
      accountIndex: 12,
    });
  });

  it('reads ?authuser= when the path has no index, and prefers the path', () => {
    expect(
      parseDocUrl(`https://docs.google.com/document/d/${ID}/edit?authuser=2`)?.accountIndex,
    ).toBe(2);
    expect(
      parseDocUrl(`https://docs.google.com/document/u/3/d/${ID}/edit?authuser=2`)?.accountIndex,
    ).toBe(3);
    expect(
      parseDocUrl(`https://docs.google.com/document/d/${ID}/edit?authuser=me@example.com`)
        ?.accountIndex,
    ).toBeUndefined();
  });

  it('refuses everything else', () => {
    for (const url of [
      'not a url',
      `http://docs.google.com/document/d/${ID}/edit`,
      `https://docs.google.com.evil.example/document/d/${ID}/edit`,
      `https://drive.google.com/file/d/${ID}/view`,
      `https://docs.google.com/forms/d/${ID}/edit`,
      'https://docs.google.com/document/d/e/2PACX-1vPublished/pub',
      'https://docs.google.com/document/u/0/',
      'https://docs.google.com/spreadsheets/d/short/edit',
    ]) {
      expect(parseDocUrl(url), url).toBeUndefined();
    }
  });
});

describe('Drive links', () => {
  it('keeps the account index', () => {
    expect(folderUrl('F1')).toBe('https://drive.google.com/drive/folders/F1');
    expect(folderUrl('F1', 2)).toBe('https://drive.google.com/drive/u/2/folders/F1');
    expect(myDriveUrl()).toBe('https://drive.google.com/drive/my-drive');
    expect(myDriveUrl(1)).toBe('https://drive.google.com/drive/u/1/my-drive');
  });

  it('encodes the id', () => {
    expect(folderUrl('a/b?c')).toBe('https://drive.google.com/drive/folders/a%2Fb%3Fc');
  });
});
