/** The file carries the frontmatter marker but cannot be read; it must never be written back. */
export class FormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FormatError";
  }
}

/** The file has no `link-figures` frontmatter marker, so it is not a figure file. */
export class NotFigureError extends Error {
  constructor(message = "Not a Link Figures file: no link-figures frontmatter key") {
    super(message);
    this.name = "NotFigureError";
  }
}
