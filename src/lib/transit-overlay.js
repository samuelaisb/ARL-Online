/**
 * The "getting there" layer on LocationMap: rapid-transit stations in their line colours with
 * a distance (an edge chip pointing the way when the station is off the map) and live bike-share
 * docks with "bikes / free docks". Bus routes come from the Transit tiles instead.
 * Imported only by LocationMap.svelte (its own lazily loaded chunk).
 *
 * Every marker is built from DOM nodes with textContent: Leaflet writes string divIcon html with
 * innerHTML, and station and dock names are third-party data. Colours were checked to be hex in
 * normalizeStations. Markers are decorative (aria-hidden); LocationMap lists the same facts in
 * text for screen readers.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';
// Static shapes (our own), drawn with currentColor.
const TRAIN_PATH =
  'M5 1h6a3 3 0 0 1 3 3v6.2a2.3 2.3 0 0 1-1.6 2.2l1.3 1.9h-1.8l-1.1-1.6H5.2l-1.1 1.6H2.3l1.3-1.9A2.3 2.3 0 0 1 2 10.2V4a3 3 0 0 1 3-3Zm-1 3.2v3h8v-3Zm1 4.9a1 1 0 1 0 0 2 1 1 0 0 0 0-2Zm6 0a1 1 0 1 0 0 2 1 1 0 0 0 0-2Z';
const BIKE_PATH = 'M5.5 16 9.5 8h6l3 8M9.5 8 12 16h2.5L15.5 8M8.5 5.5h3';
const NEUTRAL = '#3d4448';
// Containers don't place an edge chip closer than this to the map's edge.
const EDGE_INSET = 8;
const MAX_EDGE_CHIPS = 3;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) {
    node.className = className;
  }
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}

function trainIcon() {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', '13');
  svg.setAttribute('height', '13');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', TRAIN_PATH);
  path.setAttribute('fill', 'currentColor');
  svg.append(path);
  return svg;
}

function bikeIcon() {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '14');
  svg.setAttribute('height', '14');
  svg.setAttribute('aria-hidden', 'true');
  const g = document.createElementNS(SVG_NS, 'g');
  g.setAttribute('fill', 'none');
  g.setAttribute('stroke', 'currentColor');
  g.setAttribute('stroke-width', '2.2');
  g.setAttribute('stroke-linecap', 'round');
  g.setAttribute('stroke-linejoin', 'round');
  for (const cx of [5.5, 18.5]) {
    const circle = document.createElementNS(SVG_NS, 'circle');
    circle.setAttribute('cx', String(cx));
    circle.setAttribute('cy', '16');
    circle.setAttribute('r', '3.6');
    g.append(circle);
  }
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', BIKE_PATH);
  g.append(path);
  svg.append(g);
  return svg;
}

/** Dark or white text on a line colour, whichever reads better. */
function inkOn(hex) {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex);
  if (!match) {
    return '#fff';
  }
  const full = match[1].length === 3 ? match[1].replace(/./g, '$&$&') : match[1];
  const [r, g, b] = [0, 2, 4]
    .map((i) => parseInt(full.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.35 ? '#1d2a2f' : '#fff';
}

/** The station's disc: its line's colour, or a split disc for a station on several lines. */
function stationDisc(station) {
  const colours = station.lines.map((line) => line.colour || NEUTRAL);
  const disc = el('span', 'map-station__disc');
  if (colours.length > 1) {
    const step = 360 / colours.length;
    disc.style.background = `conic-gradient(${colours.map((colour, i) => `${colour} ${i * step}deg ${(i + 1) * step}deg`).join(',')})`;
    disc.style.color = '#fff';
  } else {
    disc.style.background = colours[0] ?? NEUTRAL;
    disc.style.color = inkOn(colours[0] ?? NEUTRAL);
  }
  disc.append(trainIcon());
  return disc;
}

function lineChips(station) {
  const wrap = el('span', 'map-station__lines');
  for (const line of station.lines) {
    if (!line.ref) {
      continue;
    }
    const chip = el('span', 'map-station__line', line.ref);
    chip.style.background = line.colour || NEUTRAL;
    chip.style.color = inkOn(line.colour || NEUTRAL);
    wrap.append(chip);
  }
  return wrap;
}

function metresBetween(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
}

function overlaps(a, b) {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

/**
 * Adds the layer to `map`. `origin` ({ lat, lon }) is the pin, or the public area's (already
 * rounded) centre, for distances and edge-chip bearings. `text.distance(metres)` formats a
 * distance, `text.elevator` names the step-free mark. Returns `{ setDocks(docks), layout(), destroy() }`.
 */
export function createTransitOverlay(L, map, { origin, stations = [], text }) {
  const layer = L.layerGroup().addTo(map);
  const container = map.getContainer();
  const edgePane = el('div', 'map-edges');
  edgePane.setAttribute('aria-hidden', 'true');
  container.append(edgePane);

  const withDistance = stations
    .map((station) => ({ ...station, distance: metresBetween(origin, station) }))
    .sort((a, b) => a.distance - b.distance);

  // Stations: one marker each; layout() shows it only when its disc and label fit on the map,
  // and gives every other station an edge chip instead.
  const stationItems = withDistance.map((station) => {
    const root = el('span', 'map-station');
    root.setAttribute('aria-hidden', 'true');
    root.append(stationDisc(station));
    const label = el('span', 'map-station__label');
    label.append(el('span', 'map-station__name', station.name), lineChips(station));
    if (station.wheelchair === true) {
      const lift = el('span', 'map-station__lift', '♿');
      lift.title = text.elevator;
      label.append(lift);
    }
    label.append(el('span', 'map-station__distance', text.distance(station.distance)));
    root.append(label);
    const marker = L.marker([station.lat, station.lon], {
      icon: L.divIcon({ className: 'map-marker', html: root, iconSize: [22, 22], iconAnchor: [11, 11] }),
      interactive: false,
      keyboard: false,
      zIndexOffset: 1000,
    }).addTo(layer);
    return { station, marker, root, label };
  });

  let dockItems = [];

  function containerRect(node) {
    const box = node.getBoundingClientRect();
    const outer = container.getBoundingClientRect();
    return { left: box.left - outer.left, right: box.right - outer.left, top: box.top - outer.top, bottom: box.bottom - outer.top };
  }

  function controlRects() {
    return [...container.querySelectorAll('.leaflet-control')]
      .filter((node) => node.offsetParent !== null)
      .map(containerRect);
  }

  const within = (rect, size) =>
    rect.left >= EDGE_INSET && rect.top >= EDGE_INSET && rect.right <= size.x - EDGE_INSET && rect.bottom <= size.y - EDGE_INSET;

  /** Shows the station on the map if it fits there (label flipped left at the right edge). */
  function placeOnMap(item, size, blocked) {
    const { root, label } = item;
    root.hidden = false;
    root.classList.remove('map-station--left');
    if (!item.marker.getElement()) {
      return false;
    }
    const disc = containerRect(root.firstChild);
    let labelBox = containerRect(label);
    if (labelBox.right > size.x - EDGE_INSET) {
      root.classList.add('map-station--left');
      labelBox = containerRect(label);
    }
    const fits =
      within(disc, size) &&
      within(labelBox, size) &&
      !blocked.some((rect) => overlaps(disc, rect) || overlaps(labelBox, rect));
    root.hidden = !fits;
    return fits ? [disc, labelBox] : false;
  }

  /**
   * A free spot for an edge chip: along its edge, nearest the ideal first; then, on the top or
   * bottom edge, one row further in. Null when none is clear.
   */
  function findSpot(width, height, ideal, onSide, size, taken) {
    const maxLeft = size.x - EDGE_INSET - width;
    const maxTop = size.y - EDGE_INSET - height;
    if (maxLeft < EDGE_INSET || maxTop < EDGE_INSET) {
      return null;
    }
    const clear = (left, top) => {
      const box = { left, top, right: left + width, bottom: top + height };
      return !taken.some((rect) => overlaps(box, rect));
    };
    const scan = (fixed, max, target, vertical) => {
      const positions = [];
      for (let value = EDGE_INSET; value < max; value += 4) {
        positions.push(value);
      }
      positions.push(max);
      positions.sort((a, b) => Math.abs(a - target) - Math.abs(b - target));
      for (const value of positions) {
        const [left, top] = vertical ? [fixed, value] : [value, fixed];
        if (clear(left, top)) {
          return { left, top };
        }
      }
      return null;
    };

    if (onSide) {
      return scan(ideal.left, maxTop, ideal.top, true);
    }
    const inward = ideal.top + height / 2 < size.y / 2 ? height + 4 : -(height + 4);
    return (
      scan(ideal.top, maxLeft, ideal.left, false) ??
      scan(Math.min(Math.max(ideal.top + inward, EDGE_INSET), maxTop), maxLeft, ideal.left, false)
    );
  }

  // Edge chips for stations that aren't shown on the map: nearest first, one per 30° of
  // bearing, at most three, where the ray from the origin leaves the frame, kept clear of the
  // controls, the pin, stations and each other. A chip that finds no room drops its name, then
  // itself.
  function layoutEdges(offMap, size, taken) {
    edgePane.replaceChildren();
    const from = map.latLngToContainerPoint([origin.lat, origin.lon]);
    const used = [];

    for (const { station } of offMap) {
      if (used.length >= MAX_EDGE_CHIPS) {
        break;
      }
      const to = map.latLngToContainerPoint([station.lat, station.lon]);
      const angle = Math.atan2(to.y - from.y, to.x - from.x);
      if (used.some((other) => Math.abs(((angle - other + 3 * Math.PI) % (2 * Math.PI)) - Math.PI) < Math.PI / 6)) {
        continue;
      }

      const chip = el('span', 'map-edge');
      const arrow = el('span', 'map-edge__arrow', '➜');
      arrow.style.transform = `rotate(${angle}rad)`;
      chip.append(arrow, stationDisc(station), el('span', 'map-station__name', station.name), lineChips(station));
      if (station.wheelchair === true) {
        chip.append(el('span', 'map-station__lift', '♿'));
      }
      chip.append(el('span', 'map-station__distance', text.distance(metresBetween(origin, station))));
      edgePane.append(chip);

      // Where the ray leaves the inset frame.
      const dx = Math.cos(angle);
      const dy = Math.sin(angle);
      const tx = dx > 0 ? (size.x - EDGE_INSET - from.x) / dx : dx < 0 ? (EDGE_INSET - from.x) / dx : Infinity;
      const ty = dy > 0 ? (size.y - EDGE_INSET - from.y) / dy : dy < 0 ? (EDGE_INSET - from.y) / dy : Infinity;
      const t = Math.max(0, Math.min(tx, ty));
      const exit = { x: from.x + dx * t, y: from.y + dy * t };
      const onSide = tx < ty;

      let spot = null;
      for (const compact of [false, true]) {
        chip.classList.toggle('map-edge--compact', compact);
        const width = chip.offsetWidth;
        const height = chip.offsetHeight;
        const ideal = {
          left: onSide
            ? exit.x < size.x / 2
              ? EDGE_INSET
              : size.x - EDGE_INSET - width
            : Math.min(Math.max(exit.x - width / 2, EDGE_INSET), size.x - EDGE_INSET - width),
          top: onSide
            ? Math.min(Math.max(exit.y - height / 2, EDGE_INSET), size.y - EDGE_INSET - height)
            : exit.y < size.y / 2
              ? EDGE_INSET
              : size.y - EDGE_INSET - height,
        };
        spot = findSpot(width, height, ideal, onSide, size, taken);
        if (spot) {
          taken.push({ left: spot.left, top: spot.top, right: spot.left + width, bottom: spot.top + height });
          break;
        }
      }

      if (!spot) {
        chip.remove();
        continue;
      }
      used.push(angle);
      chip.style.left = `${Math.round(spot.left)}px`;
      chip.style.top = `${Math.round(spot.top)}px`;
    }
  }

  // Docks give way to everything else: an icon that is cut by the frame or would sit under a
  // station, a chip, the pin or a control is dropped whole; a count that would be cut or cover
  // another label is hidden.
  function layoutDocks(taken, size) {
    const inFrame = (rect) => rect.left >= 0 && rect.top >= 0 && rect.right <= size.x && rect.bottom <= size.y;
    for (const item of dockItems) {
      item.root.hidden = false;
      item.count.hidden = false;
    }
    for (const item of dockItems) {
      if (!item.marker.getElement()) {
        continue;
      }
      const icon = containerRect(item.icon);
      if (!inFrame(icon) || taken.some((rect) => overlaps(icon, rect))) {
        item.root.hidden = true;
        continue;
      }
      taken.push(icon);
      const count = containerRect(item.count);
      if (!inFrame(count) || taken.some((rect) => overlaps(count, rect))) {
        item.count.hidden = true;
      } else {
        taken.push(count);
      }
    }
  }

  function layout() {
    const size = map.getSize();
    const pin = container.querySelector('.location-map__pin');
    const taken = [...controlRects(), ...(pin ? [containerRect(pin)] : [])];
    const offMap = [];
    for (const item of stationItems) {
      const rects = placeOnMap(item, size, taken);
      if (rects) {
        taken.push(...rects);
      } else {
        offMap.push(item);
      }
    }
    layoutEdges(offMap, size, taken);
    layoutDocks(taken, size);
  }

  map.on('zoomend moveend resize', layout);
  layout();

  return {
    setDocks(docks) {
      for (const item of dockItems) {
        layer.removeLayer(item.marker);
      }
      dockItems = docks.map((dock, index) => {
        const root = el('span', `map-dock${dock.bikes === 0 ? ' map-dock--empty' : ''}`);
        root.setAttribute('aria-hidden', 'true');
        const icon = el('span', 'map-dock__icon');
        icon.append(bikeIcon());
        const count = el('span', 'map-dock__count');
        count.append(String(dock.bikes), el('span', 'map-dock__sep', '/'), String(dock.freeDocks));
        root.append(icon, count);
        const marker = L.marker([dock.lat, dock.lon], {
          icon: L.divIcon({ className: 'map-marker', html: root, iconSize: [20, 20], iconAnchor: [10, 10] }),
          interactive: false,
          keyboard: false,
          zIndexOffset: 500 - index,
        }).addTo(layer);
        return { marker, root, icon, count };
      });
      layout();
    },
    /** Again after the credits change size (a tile layer or the bike-share credit). */
    layout,
    destroy() {
      map.off('zoomend moveend resize', layout);
      edgePane.remove();
      layer.remove();
    },
  };
}
