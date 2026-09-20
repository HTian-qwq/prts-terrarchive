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

export interface SourceMarkdownLine { line_number: number; text: string; speaker_raw?: string }

/** Block rendering retains source ranges, including lists/tables spanning returned lines. */
export function renderSourceMarkdown(lines: readonly SourceMarkdownLine[]): HTMLElement[] {
  const rows:HTMLElement[]=[];
  const add=(start:number,end:number,text:string,speaker?:string)=>{
    const row=document.createElement('div');row.className='rhine-reader-line';
    row.dataset.line=String(start);row.dataset.lineEnd=String(end);row.id=`rhine-line-${start}`;
    const number=document.createElement('span');number.className='rhine-line-number';
    number.textContent=start===end?String(start).padStart(3,'0'):`${start}–${end}`;
    number.title=start===end?`原文第 ${start} 行`:`原文第 ${start}–${end} 行`;
    const body=document.createElement('div');body.className='rhine-line-text rhine-markdown';
    // Local lines may carry both speaker_raw and the same serialized prefix.
    // Strip only an exact leading identity followed by a colon; speech stays intact.
    const identity=speaker?.trim();
    if(identity){const escaped=identity.replace(/[.*+?^${}()|[\]\\]/gu,'\\$&');text=text.replace(new RegExp(`^\\s*${escaped}\\s*[：:]\\s*`,'u'),'');}
    renderReportMarkdown(body,text);
    // Speaker identities remain literal, even if they contain Markdown punctuation.
    if(speaker){const label=document.createElement('span');label.className='rhine-speaker';label.textContent=`${speaker}　`;body.prepend(label);}
    row.append(number,body);rows.push(row);
  };
  let offset=0;
  while(offset<lines.length){
    if(lines[offset].speaker_raw){const line=lines[offset++];add(line.line_number,line.line_number,line.text,line.speaker_raw);continue;}
    let end=offset+1;while(end<lines.length&&!lines[end].speaker_raw&&lines[end].line_number===lines[end-1].line_number+1)end++;
    const chunk=lines.slice(offset,end), virtual:string[]=[],owners:number[]=[];
    for(let i=0;i<chunk.length;i++)for(const part of chunk[i].text.split(/\r?\n/)){virtual.push(part);owners.push(i);}
    const tokens=markdown.parse(virtual.join('\n'),{});
    for(let i=0;i<tokens.length;){
      const token=tokens[i];let j=i+1;
      if(token.nesting===1){let nesting=1;while(j<tokens.length&&nesting){nesting+=tokens[j].nesting;j++;}}
      if(token.map){
        const a=token.map[0];let b=token.map[1];
        while(b>a+1&&!virtual[b-1].trim())b--;
        const first=owners[a],last=owners[Math.max(a,b-1)];
        if(token.type==='paragraph_open'&&first!==last){
          for(let n=first;n<=last;n++)add(chunk[n].line_number,chunk[n].line_number,chunk[n].text);
        }else add(chunk[first].line_number,chunk[last].line_number,virtual.slice(a,b).join('\n'));
      }
      i=j;
    }
    offset=end;
  }
  return rows;
}
