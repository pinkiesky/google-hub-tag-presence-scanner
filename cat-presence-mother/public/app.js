const tagsElement = document.getElementById('tags');
const connection = document.getElementById('connection');
let refreshing = false;

function cell(value) {
  const element = document.createElement('td');
  element.textContent = value;
  return element;
}

function signal(value) {
  return value === null ? '—' : `${Number(value.toFixed(1))} dBm`;
}

function renderTag(tag) {
  const section = document.createElement('section');
  const title = document.createElement('h2');
  const summary = document.createElement('p');
  const table = document.createElement('table');
  const header = document.createElement('thead');
  const headings = document.createElement('tr');
  const body = document.createElement('tbody');

  title.textContent = tag.name;
  summary.textContent = `${tag.present ? 'Present' : 'Not present'} · strongest signal: ${signal(tag.maxSignalDbm)}`;
  for (const label of ['Source', 'Status', 'Average signal']) {
    const heading = document.createElement('th');
    heading.scope = 'col';
    heading.textContent = label;
    headings.append(heading);
  }
  header.append(headings);
  for (const source of tag.sources) {
    const row = document.createElement('tr');
    const name = document.createElement('th');
    name.scope = 'row';
    name.textContent = source.name;
    row.append(
      name,
      cell(source.present ? 'Present' : 'Not present'),
      cell(signal(source.averageSignalDbm)),
    );
    body.append(row);
  }
  table.append(header, body);
  section.append(title, summary, table);
  return section;
}

async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    const response = await fetch('/api/tags', { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const { tags } = await response.json();
    tagsElement.replaceChildren(...tags.map(renderTag));
    connection.textContent = 'Live · updates every second';
  } catch {
    connection.textContent = 'Connection lost · retrying…';
  } finally {
    refreshing = false;
  }
}

void refresh();
setInterval(refresh, 1000);
