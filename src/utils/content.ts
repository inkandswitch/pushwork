/**
 * Compare two content pieces for equality
 */
export function isContentEqual(
  content1: string | Uint8Array | null,
  content2: string | Uint8Array | null
): boolean {
  if (content1 === content2) return true;
  if (!content1 || !content2) return false;

  if (typeof content1 !== typeof content2) return false;

  if (typeof content1 === "string") {
    return content1 === content2;
  } else {
    // Compare Uint8Array using native Buffer.equals() for better performance
    const buf1 = content1 as Uint8Array;
    const buf2 = content2 as Uint8Array;

    if (buf1.length !== buf2.length) return false;

    return Buffer.from(buf1).equals(Buffer.from(buf2));
  }
}
