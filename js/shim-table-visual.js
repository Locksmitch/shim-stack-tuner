/* =========================================================
   SHIM TABLE — read-only mirror
   The main Shim Stack Tuner page keeps its own fully-editable table (inputs, move/dup/
   remove buttons - see addShimRow() in app.js); this is the plain, read-only rendering a
   pop-out mirror shows instead, built straight from the same row objects the physics
   engine consumes (count, diam, thickness, float, type - always mm, converted to
   whatever display unit the caller wants).
   ========================================================= */
import { convLen } from './units.js';

export function renderShimTableReadOnly(tbody, rows, unit) {
  tbody.innerHTML = '';
  rows.forEach((row) => {
    const tr = document.createElement('tr');
    const cells = [
      row.count,
      convLen(row.diam, 'mm', unit).toFixed(unit === 'mm' ? 2 : 3),
      convLen(row.thickness, 'mm', unit).toFixed(unit === 'mm' ? 3 : 4),
      row.float > 0 ? convLen(row.float, 'mm', unit).toFixed(unit === 'mm' ? 3 : 4) : '—',
      row.type === 'deltaT' ? 'Delta T' : 'Round',
      unit,
    ];
    cells.forEach((text) => {
      const td = document.createElement('td');
      td.textContent = text;
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
}
