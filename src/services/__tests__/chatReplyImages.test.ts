/**
 * Generated images in chat replies: moved out of the stored text, restored for sending.
 * Run: npx tsx src/services/__tests__/chatReplyImages.test.ts
 */
import { extractReplyImages, inlineReplyImages, splitInlineImages, stripReplyImages } from '../chatAttachments';

let passed = 0;
let failed = 0;

async function test(description: string, fn: () => Promise<void>): Promise<void> {
    try {
        await fn();
        passed += 1;
        console.log(`  ok  ${description}`);
    } catch (err) {
        failed += 1;
        console.error(`  FAIL  ${description}`);
        console.error(err);
    }
}

function assertEqual<T>(actual: T, expected: T): void {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
}

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
let counter = 0;
const makeId = () => `img-${++counter}`;

async function main(): Promise<void> {
    // No IndexedDB under node: payloads stay in the in-memory cache.
    console.warn = () => {};

    await test('extract replaces inline images with attachment references', async () => {
        const { text, images } = extractReplyImages(`Here:\n![image](data:image/png;base64,${PNG})\n![image](data:image/jpeg;base64,${PNG})`, makeId);
        assertEqual(text, 'Here:\n![image](attachment:img-1)\n![image](attachment:img-2)');
        assertEqual(images.map((i) => [i.id, i.mime, i.name, i.kind]), [
            ['img-1', 'image/png', 'image.png', 'image'],
            ['img-2', 'image/jpeg', 'image.jpg', 'image'],
        ]);
    });

    await test('extract leaves an image that is still streaming in place', async () => {
        const partial = `![image](data:image/png;base64,${PNG.slice(0, 20)}`;
        assertEqual(extractReplyImages(partial, makeId), { text: partial, images: [] });
    });

    await test('inline restores stored payloads as data URLs and notes missing ones', async () => {
        const { text, images } = extractReplyImages(`a ![x](data:image/png;base64,${PNG}) b ![y](attachment:gone)`, makeId);
        assertEqual(await inlineReplyImages(text, images), `a ![x](data:image/png;base64,${PNG}) b [Image unavailable]`);
    });

    await test('split yields Gemini-style text and image parts', async () => {
        assertEqual(splitInlineImages(`before ![i](data:image/webp;base64,${PNG}) after`), [
            { text: 'before ' },
            { mime: 'image/webp', data: PNG },
            { text: ' after' },
        ]);
        assertEqual(splitInlineImages('plain'), [{ text: 'plain' }]);
    });

    await test('strip removes image markup for copying', async () => {
        assertEqual(stripReplyImages('Done!\n![image](attachment:img-1)\n'), 'Done!');
        assertEqual(stripReplyImages('![image](attachment:img-1)'), '');
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) {
        throw new Error(`${failed} test(s) failed`);
    }
}

// An unhandled rejection exits non-zero.
void main();
