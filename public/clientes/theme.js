// Aplica el tema guardado antes de pintar la página (evita el parpadeo oscuro → día).
// El interruptor y el guardado de la preferencia están en clientes.js.
(() => {
  let theme = 'dark';
  try {
    if (localStorage.getItem('barbuzano-theme') === 'light') theme = 'light';
  } catch (e) { /* almacenamiento no disponible: se queda en oscuro */ }
  document.documentElement.dataset.theme = theme;
})();
