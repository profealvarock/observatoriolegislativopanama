// Pruebas de la regla de frescura de la interfaz (js/indicadores.js). Correr con:  node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { frescura, indDiasEntre, fmtPeriodo, hoyPanama } = require('../js/indicadores.js');

test('umbrales de 7 y 30 días', () => {
  const hoy = '2026-11-23';
  assert.deepEqual(frescura('2026-11-23', hoy), { nivel: 'verde', dias: 0 });
  assert.deepEqual(frescura('2026-11-16', hoy), { nivel: 'verde', dias: 7 });
  assert.deepEqual(frescura('2026-11-15', hoy), { nivel: 'ambar', dias: 8 });
  assert.deepEqual(frescura('2026-10-24', hoy), { nivel: 'ambar', dias: 30 });
  assert.deepEqual(frescura('2026-10-23', hoy), { nivel: 'rojo', dias: 31 });
});

test('sin fecha o fecha inválida → s/d', () => {
  assert.equal(frescura(null, '2026-11-23').nivel, 'sd');
  assert.equal(frescura('', '2026-11-23').nivel, 'sd');
  assert.equal(frescura('pendiente', '2026-11-23').nivel, 'sd');
});

test('cuenta días de calendario, también al cruzar meses y años', () => {
  assert.equal(indDiasEntre('2026-10-09', '2026-11-20'), 42);
  assert.equal(indDiasEntre('2026-12-25', '2027-01-08'), 14);
  assert.equal(indDiasEntre('2026-02-28', '2026-03-01'), 1);
});

test('hoy se calcula en la zona horaria de Panamá', () => {
  // 2026-11-21 03:00 UTC todavía es 20 de noviembre en Panamá (UTC-5)
  assert.equal(hoyPanama(new Date('2026-11-21T03:00:00Z')), '2026-11-20');
  assert.equal(hoyPanama(new Date('2026-11-21T06:00:00Z')), '2026-11-21');
});

test('formato de períodos', () => {
  assert.equal(fmtPeriodo('2026-11-13/2026-11-27'), '13 – 27 nov 2026');
  assert.equal(fmtPeriodo('2026-10-30/2026-11-13'), '30 oct – 13 nov 2026');
  assert.equal(fmtPeriodo('2026-06'), 'jun 2026');
  assert.equal(fmtPeriodo('2026'), '2026');
  assert.equal(fmtPeriodo(null), 's/d');
});
