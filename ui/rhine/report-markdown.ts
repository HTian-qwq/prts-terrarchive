import MarkdownIt from 'markdown-it';

// Reports are model text, never executable HTML. Keep rendering local, including
// images: a streamed answer must not trigger arbitrary background requests.
const markdown = new MarkdownIt({ html: false, linkify: false, typographer: false });
markdown.renderer.rules.image = (tokens, index) => `<span class="rhine-report-image-caption">${markdown.utils.escapeHtml(tokens[index].content || '图片')}</span>`;

export interface ReportHeading { id: string; label: string; level: number }

export function renderReportMarkdown(target: HTMLElement, text: string,
  measure: <T>(kind: string, work: () => T) => T = (_kind, work) => work()): ReportHeading[] {
  const { fragment, headings } = measure('report-markdown', () => {
  const template = document.createElement('template');
  template.innerHTML = markdown.render(text);
  const fragment = template.content;
  const headings = [...fragment.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6')].map((heading, index) => {
    heading.id = `rhine-report-section-${index + 1}`;
    heading.tabIndex = -1;
    return { id: heading.id, label: heading.textContent || `章节 ${index + 1}`, level: Number(heading.tagName.slice(1)) };
  });
  for (const link of fragment.querySelectorAll<HTMLAnchorElement>('a')) {
    const href = link.getAttribute('href') || '';
    if (href.startsWith('#')) continue;
    try {
      const url = new URL(href);
      if (!['https:', 'http:', 'mailto:'].includes(url.protocol)) { link.removeAttribute('href'); continue; }
      link.target = '_blank'; link.rel = 'noopener noreferrer';
    } catch { link.removeAttribute('href'); }
  }
  for (const table of fragment.querySelectorAll('table')) {
    const wrapper = document.createElement('div');
    wrapper.className = 'rhine-report-table';
    wrapper.tabIndex = 0;
    wrapper.setAttribute('role', 'region');
    wrapper.setAttribute('aria-label', '报告表格，可横向滚动');
    table.replaceWith(wrapper); wrapper.append(table);
  }
    return { fragment, headings };
  });
  measure('report-body-patch', () => {
  // Leave completed paragraphs in place while the final paragraph streams.
  // This preserves selection, focus and the reader's position in earlier text.
  const next = [...fragment.childNodes];
  next.forEach((node, index) => {
    const previous = target.childNodes[index];
    if (!previous) target.append(node);
    else if (!previous.isEqualNode(node)) target.replaceChild(node, previous);
  });
  while (target.childNodes.length > next.length) target.lastChild!.remove();
  });
  return headings;
}
