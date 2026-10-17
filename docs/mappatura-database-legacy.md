# Mappatura del database del vecchio programma Cassa 2.0.x

Il vecchio programma (Cassa 2.0.4, .NET 3.5, database Firebird 2.5) usa colonne con nomi generici
`DATA1…DATAn`. Il significato qui sotto è stato ricavato dal codice decompilato
(`sorgenti/Cassa`, in particolare le classi che leggono e scrivono le tabelle) e verificato sul file di
esportazione reale del 2019. Gli identificativi sono numeri a 17 cifre costruiti dal timestamp di
creazione (`yyyyMMddHHmmssfff`).

## Formato del file di esportazione (cartella `Save/`)

```
[TABELLA]
Fields=COL1;COL2;...
valore;'stringa con ''apice''';1,5
```

- separatore `;`, stringhe tra apici con apice raddoppiato come escape, decimali con la virgola;
- codifica Windows-1252;
- tabelle esportate: `CONFIG`, `FAMILY`, `PRODUCT`, `MENULIST`, `MENUCOMP`, `MENUPROD`, `STORAGE`
  (solo il catalogo, non le vendite).

## FAMILY — famiglie di prodotti

| Colonna | Significato | Nuova Cassa |
|---|---|---|
| IDFAMILY | id | — |
| DATA1 | nome | `families.name` |
| DATA2 | visibile (`T`/`F`) | `families.visible` |
| DATA3 | indice interno del bottone | non usato |
| DATA4 | colore, intero ARGB .NET con segno (es. -128 = `#FFFF80`) | `families.color` |
| DATA5 | ordine | `families.sort` |

## PRODUCT — prodotti

| Colonna | Significato | Nuova Cassa |
|---|---|---|
| IDPRODUCT | id | `products.legacy_id` |
| IDFAMILY | famiglia | `products.family_id` |
| IDKORDER | numero della comanda/reparto (-1 = nessuna) | `products.station_id` |
| DATA1 | modalità quantità: 0 fissa, 1 variabile | non necessario (la quantità si imposta sempre) |
| DATA2 | nome | `products.name` |
| DATA3 | visibile | `products.visible` |
| DATA4 | codice a barre (EAN, 13 cifre) | non usato |
| DATA5 | prezzo in euro; -1 = prezzo libero | `products.price_cents` (NULL = libero) |
| DATA6 | quantità: -1 illimitata, -2 magazzino condiviso, ≥0 quantità propria | `stock_mode`, `stock_qty` |
| DATA7 | soglia sotto scorta | `products.low_stock` |
| DATA8 | stampa in comanda: `G` raggruppata, `S` separata, `O` solo scontrino | `products.print_mode` |
| DATA9 | unità scaricate dal magazzino per pezzo | `products.stock_units` |
| DATA10, DATA11 | non usati nei dati reali | — |
| DATA12 | descrizione | non usato |
| DATA13 | ordine del bottone | `products.sort` |
| DATA14 | visibile solo nei menù | `products.menu_only` |
| IDSTORAGE | magazzino condiviso (se DATA6 = -2) | `products.storage_id` |

## STORAGE — magazzini condivisi

| Colonna | Significato |
|---|---|
| IDSTORAGE | id |
| DATA1 | nome |
| DATA2 | quantità disponibile |

## MENULIST / MENUCOMP / MENUPROD — menù

| Tabella.Colonna | Significato |
|---|---|
| MENULIST.DATA1 | ordine |
| MENULIST.DATA2 | nome |
| MENULIST.DATA3 | visibile |
| MENULIST.DATA4 | prezzo |
| MENULIST.DATA5 | colore ARGB |
| MENUCOMP.IDMENULIST | menù di appartenenza |
| MENUCOMP.DATA1 | ordine |
| MENUCOMP.DATA2 | nome del componente |
| MENUPROD.IDMENUCOMP / IDPRODUCT | prodotto selezionabile nel componente |
| MENUPROD.DATA2 | ordine |

Nel vecchio programma ogni componente prevedeva una sola scelta; in Nuova Cassa `choices` è 1
per i menù importati e si può aumentare.

## CONFIG — impostazioni

Righe `(SEQ, GRP, DATA1, DSC)`; `DSC` è la descrizione leggibile. Il gruppo 7 contiene le comande:
`SEQ = 100 + 10·n + campo`, dove `n` è il numero della comanda (lo stesso di `PRODUCT.IDKORDER`) e
`campo` 3 = nome, 1 = stato di abilitazione, 4 = "riversa su file". In Nuova Cassa ogni comanda con
nome diventa un reparto (`stations`).

## Tabelle delle vendite (non esportate)

Per completezza, nel database `CASSA.FDB`: `TICKETH` (testata scontrino), `TICKETL` (righe),
`TICKETLM` (prodotti scelti nei menù), `TICKETP` (pagamenti), `TICKETS` (storni), `TICKETK`
(stato delle comande in cucina), `MULTIALC`/`MULTIMSG` (coordinamento tra più casse). Lo storico
vendite non viene importato: per leggerlo serve un server Firebird 2.5.
