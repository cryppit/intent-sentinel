// Another site could show this page inside a frame and trick a click (clickjacking). A <meta> CSP can't forbid framing,
// and GitHub Pages sends no header for it, so the page checks for itself. A frame we can't even look at counts as framed.
export function framed(win) {
  try {
    return win.top !== win.self;
  } catch {
    return true;
  }
}
