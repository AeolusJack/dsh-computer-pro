const normalize = text => text.normalize('NFKC').replace(/\s+/gu, '').toLocaleLowerCase();
/** Exact contiguous words on one OCR line. Coordinates stay in original image pixels. */
export function findOcrTargets(result, text) {
  if (typeof text !== 'string' || !text.trim() || text.length > 256) throw new Error('INVALID_OCR_TEXT');
  const needle = normalize(text), matches = [];
  for (const [lineIndex, line] of (result.lines ?? []).entries()) {
    const words = line.words ?? [];
    if (words.length > 2000) throw new Error('OCR_WORD_LIMIT');
    for (let start = 0; start < words.length; start++) {
      let value = '';
      for (let end = start; end < words.length && end < start + 128; end++) {
        value += normalize(words[end].text ?? '');
        if (!needle.startsWith(value)) break;
        if (value !== needle) continue;
        const span = words.slice(start, end + 1);
        if (span.some(w => ![w.x,w.y,w.width,w.height].every(Number.isFinite) || w.width <= 0 || w.height <= 0)) break;
        const x = Math.min(...span.map(w => w.x)), y = Math.min(...span.map(w => w.y));
        const right = Math.max(...span.map(w => w.x + w.width)), bottom = Math.max(...span.map(w => w.y + w.height));
        matches.push({ text: span.map(w => w.text).join(' '), line: lineIndex, bounds: {x,y,width:right-x,height:bottom-y},
          point: {x:Math.floor((x+right)/2),y:Math.floor((y+bottom)/2)}, confidence: null });
        break;
      }
    }
  }
  return { text, count: matches.length, matches, coordinateSpace: 'image-pixels-top-left', width: result.width, height: result.height };
}
