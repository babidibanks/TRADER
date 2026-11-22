# 🕯️ Candle Quest — Diario de trading gamificado

Un diario de trading tipo Tamagotchi. Tu mascota, **Velita** (un espíritu-vela), se alimenta de trades bien documentados y de tu disciplina, no de tus ganancias.

## Cómo usarlo
1. Abre `index.html` en el navegador (doble clic). No necesita instalación ni servidor, y funciona sin internet.
2. **Ajustes** → pon tu nombre, el capital inicial, la moneda y **tus reglas** (cada regla se convierte en el checklist de cada trade).
3. **+ Trade** → registra la operación. Las capturas se pegan con **Ctrl+V** directamente desde TradingView/MT4 (Win+Shift+S → Ctrl+V), o se arrastran.
4. ¿Quieres verlo lleno? Ajustes → *Cargar datos de ejemplo* (y luego *Borrar todo*).

## En el móvil
En pantallas pequeñas ves una sola pantalla simple: la mascota, tu capital, el PNL, la barra de la meta (500 € → 10.000 €, editable en Ajustes, con el % mensual que necesitas para llegar), el conteo de victorias / stop loss / derrotas / break-even y los 10 últimos trades. Con el botón **+** registras un trade nuevo.

## Qué incluye
- **Mascota que evoluciona**: Huevo → Bebé (Lv 2) → Joven (Lv 5) → Adulto (Lv 10) → Leyenda (Lv 20). Se pone verde, amarilla, roja o gris según su HP.
- **HP = disciplina (55%) + diario completo (45%)** de tus últimos 10 trades, menos una penalización por cada trade con más de un día sin revisar.
- **XP por proceso**: motivo, capturas antes/después, lección, emociones y checklist. El dinero no da XP.
- **Misiones diarias/semanales** y **18 logros**.
- **Cálculo automático**: pips (los pares JPY usan 0.01), R múltiple, R:R planificado, % de riesgo real y sesión (Asia / Londres / solape / NY).
- **Estadísticas**: neto, % de rentabilidad, win rate, profit factor, expectativa (€ y R), payoff, drawdown máximo, recovery factor, Sharpe, rachas, duración media, equity, curva de drawdown, distribución de R y calendario de P&L. También desgloses por par, sesión, setup, día, dirección, emoción, timeframe y calidad de ejecución.
- **"Lo que dicen tus datos"**: compara lo que ganas cumpliendo reglas con lo que ganas rompiéndolas, y señala tu mejor/peor par, sesión y setup.
- **Informe Pro**: track record imprimible (o en PDF) con métricas clave, curva de capital, tabla de rentabilidad mensual, desgloses y tus reglas. Es el documento para enseñar a un profesional.

## Datos
Todo se guarda en tu navegador (IndexedDB). **Exporta una copia JSON a menudo** desde Ajustes: incluye las capturas. También hay exportación a CSV para Excel.
