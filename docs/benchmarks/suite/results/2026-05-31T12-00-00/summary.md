# Benchmark suite summary

- Generated: 2026-05-31T12:00:00.000Z
- Filters: repo=all, task=all, mode=warm, trials=3
- cells_skipped_for_install: 0
- Cells skipped for env drift: 0
- Per-repo rows only.

## explain-runtime

### Warm cache

| Repo | Status | Isolation | Reason | Baseline input tokens | Madar input tokens | SPI Madar input tokens | Baseline tool calls | Madar tool calls | SPI Madar tool calls | Baseline Read | Madar Read | SPI Madar Read | Baseline Glob/Grep | Madar Glob/Grep | SPI Madar Glob/Grep | Baseline wall-clock (ms) | Madar wall-clock (ms) | SPI Madar wall-clock (ms) | Baseline cost (USD) | Madar cost (USD) | SPI Madar cost (USD) | Workflow outcomes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| ts-small | completed | true | — | 530 (525-535, n=3) | 360 (355-365, n=3) | 320 (315-325, n=3) | 14 (14-14, n=3) | 9 (9-9, n=3) | 7 (7-7, n=3) | 5 (5-5, n=3) | 3 (3-3, n=3) | 2 (2-2, n=3) | 6 (6-6, n=3) | 3 (3-3, n=3) | 2 (2-2, n=3) | 14100 (14050-14150, n=3) | 10900 (10850-10950, n=3) | 9900 (9850-9950, n=3) | 1.82 (1.81-1.83, n=3) | 1.38 (1.37-1.39, n=3) | 1.20 (1.19-1.21, n=3) | — |
| nestjs-mid | completed | true | — | 570 (565-575, n=3) | 400 (395-405, n=3) | 360 (355-365, n=3) | 14 (14-14, n=3) | 9 (9-9, n=3) | 7 (7-7, n=3) | 5 (5-5, n=3) | 3 (3-3, n=3) | 2 (2-2, n=3) | 6 (6-6, n=3) | 3 (3-3, n=3) | 2 (2-2, n=3) | 14420 (14370-14470, n=3) | 11220 (11170-11270, n=3) | 10220 (10170-10270, n=3) | 1.92 (1.91-1.93, n=3) | 1.48 (1.47-1.49, n=3) | 1.30 (1.29-1.31, n=3) | — |
| ts-monorepo-large | completed | true | — | 610 (605-615, n=3) | 440 (435-445, n=3) | 400 (395-405, n=3) | 14 (14-14, n=3) | 9 (9-9, n=3) | 7 (7-7, n=3) | 5 (5-5, n=3) | 3 (3-3, n=3) | 2 (2-2, n=3) | 6 (6-6, n=3) | 3 (3-3, n=3) | 2 (2-2, n=3) | 14740 (14690-14790, n=3) | 11540 (11490-11590, n=3) | 10540 (10490-10590, n=3) | 2.02 (2.01-2.03, n=3) | 1.58 (1.57-1.59, n=3) | 1.40 (1.39-1.41, n=3) | — |

## implement

### Warm cache

| Repo | Status | Isolation | Reason | Baseline input tokens | Madar input tokens | SPI Madar input tokens | Baseline tool calls | Madar tool calls | SPI Madar tool calls | Baseline Read | Madar Read | SPI Madar Read | Baseline Glob/Grep | Madar Glob/Grep | SPI Madar Glob/Grep | Baseline wall-clock (ms) | Madar wall-clock (ms) | SPI Madar wall-clock (ms) | Baseline cost (USD) | Madar cost (USD) | SPI Madar cost (USD) | Workflow outcomes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| ts-small | completed | true | — | 565 (560-570, n=3) | 395 (390-400, n=3) | 355 (350-360, n=3) | 14 (14-14, n=3) | 9 (9-9, n=3) | 7 (7-7, n=3) | 6 (6-6, n=3) | 3 (3-3, n=3) | 2 (2-2, n=3) | 6 (6-6, n=3) | 3 (3-3, n=3) | 2 (2-2, n=3) | 14240 (14190-14290, n=3) | 11040 (10990-11090, n=3) | 10040 (9990-10090, n=3) | 1.89 (1.88-1.90, n=3) | 1.45 (1.44-1.46, n=3) | 1.27 (1.26-1.28, n=3) | legacy: validation pass 2/3; wrong-file edits 0 (0-1, n=3); rework 2 (1-3, n=3); human intervention 1/3; SPI: validation pass 3/3; wrong-file edits 0 (0-0, n=3); rework 0 (0-0, n=3); human intervention 0/3 |
| nestjs-mid | completed | true | — | 605 (600-610, n=3) | 435 (430-440, n=3) | 395 (390-400, n=3) | 14 (14-14, n=3) | 9 (9-9, n=3) | 7 (7-7, n=3) | 6 (6-6, n=3) | 3 (3-3, n=3) | 2 (2-2, n=3) | 6 (6-6, n=3) | 3 (3-3, n=3) | 2 (2-2, n=3) | 14560 (14510-14610, n=3) | 11360 (11310-11410, n=3) | 10360 (10310-10410, n=3) | 1.99 (1.98-2.00, n=3) | 1.55 (1.54-1.56, n=3) | 1.37 (1.36-1.38, n=3) | legacy: validation pass 2/3; wrong-file edits 0 (0-1, n=3); rework 2 (1-3, n=3); human intervention 1/3; SPI: validation pass 3/3; wrong-file edits 0 (0-0, n=3); rework 0 (0-0, n=3); human intervention 0/3 |
| ts-monorepo-large | completed | true | — | 645 (640-650, n=3) | 475 (470-480, n=3) | 435 (430-440, n=3) | 14 (14-14, n=3) | 9 (9-9, n=3) | 7 (7-7, n=3) | 6 (6-6, n=3) | 3 (3-3, n=3) | 2 (2-2, n=3) | 6 (6-6, n=3) | 3 (3-3, n=3) | 2 (2-2, n=3) | 14880 (14830-14930, n=3) | 11680 (11630-11730, n=3) | 10680 (10630-10730, n=3) | 2.09 (2.08-2.10, n=3) | 1.65 (1.64-1.66, n=3) | 1.47 (1.46-1.48, n=3) | legacy: validation pass 2/3; wrong-file edits 0 (0-1, n=3); rework 2 (1-3, n=3); human intervention 1/3; SPI: validation pass 3/3; wrong-file edits 0 (0-0, n=3); rework 0 (0-0, n=3); human intervention 0/3 |

## review

### Warm cache

| Repo | Status | Isolation | Reason | Baseline input tokens | Madar input tokens | SPI Madar input tokens | Baseline tool calls | Madar tool calls | SPI Madar tool calls | Baseline Read | Madar Read | SPI Madar Read | Baseline Glob/Grep | Madar Glob/Grep | SPI Madar Glob/Grep | Baseline wall-clock (ms) | Madar wall-clock (ms) | SPI Madar wall-clock (ms) | Baseline cost (USD) | Madar cost (USD) | SPI Madar cost (USD) | Workflow outcomes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| ts-small | completed | true | — | 585 (580-590, n=3) | 415 (410-420, n=3) | 375 (370-380, n=3) | 16 (16-16, n=3) | 9 (9-9, n=3) | 7 (7-7, n=3) | 5 (5-5, n=3) | 3 (3-3, n=3) | 2 (2-2, n=3) | 6 (6-6, n=3) | 3 (3-3, n=3) | 2 (2-2, n=3) | 14320 (14270-14370, n=3) | 11120 (11070-11170, n=3) | 10120 (10070-10170, n=3) | 1.93 (1.92-1.94, n=3) | 1.49 (1.48-1.50, n=3) | 1.31 (1.30-1.32, n=3) | legacy: review time (s) 100 (95-105, n=3); rework 1 (0-2, n=3); human intervention 1/3; SPI: review time (s) 80 (75-85, n=3); rework 0 (0-0, n=3); human intervention 0/3 |
| nestjs-mid | completed | true | — | 625 (620-630, n=3) | 455 (450-460, n=3) | 415 (410-420, n=3) | 16 (16-16, n=3) | 9 (9-9, n=3) | 7 (7-7, n=3) | 5 (5-5, n=3) | 3 (3-3, n=3) | 2 (2-2, n=3) | 6 (6-6, n=3) | 3 (3-3, n=3) | 2 (2-2, n=3) | 14640 (14590-14690, n=3) | 11440 (11390-11490, n=3) | 10440 (10390-10490, n=3) | 2.03 (2.02-2.04, n=3) | 1.59 (1.58-1.60, n=3) | 1.41 (1.40-1.42, n=3) | legacy: review time (s) 100 (95-105, n=3); rework 1 (0-2, n=3); human intervention 1/3; SPI: review time (s) 80 (75-85, n=3); rework 0 (0-0, n=3); human intervention 0/3 |
| ts-monorepo-large | completed | true | — | 665 (660-670, n=3) | 495 (490-500, n=3) | 455 (450-460, n=3) | 16 (16-16, n=3) | 9 (9-9, n=3) | 7 (7-7, n=3) | 5 (5-5, n=3) | 3 (3-3, n=3) | 2 (2-2, n=3) | 6 (6-6, n=3) | 3 (3-3, n=3) | 2 (2-2, n=3) | 14960 (14910-15010, n=3) | 11760 (11710-11810, n=3) | 10760 (10710-10810, n=3) | 2.13 (2.12-2.14, n=3) | 1.69 (1.68-1.70, n=3) | 1.51 (1.50-1.52, n=3) | legacy: review time (s) 100 (95-105, n=3); rework 1 (0-2, n=3); human intervention 1/3; SPI: review time (s) 80 (75-85, n=3); rework 0 (0-0, n=3); human intervention 0/3 |

## impact

### Warm cache

| Repo | Status | Isolation | Reason | Baseline input tokens | Madar input tokens | SPI Madar input tokens | Baseline tool calls | Madar tool calls | SPI Madar tool calls | Baseline Read | Madar Read | SPI Madar Read | Baseline Glob/Grep | Madar Glob/Grep | SPI Madar Glob/Grep | Baseline wall-clock (ms) | Madar wall-clock (ms) | SPI Madar wall-clock (ms) | Baseline cost (USD) | Madar cost (USD) | SPI Madar cost (USD) | Workflow outcomes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| ts-small | completed | true | — | 550 (545-555, n=3) | 380 (375-385, n=3) | 340 (335-345, n=3) | 14 (14-14, n=3) | 9 (9-9, n=3) | 7 (7-7, n=3) | 5 (5-5, n=3) | 3 (3-3, n=3) | 2 (2-2, n=3) | 6 (6-6, n=3) | 3 (3-3, n=3) | 2 (2-2, n=3) | 14180 (14130-14230, n=3) | 10980 (10930-11030, n=3) | 9980 (9930-10030, n=3) | 1.86 (1.85-1.87, n=3) | 1.42 (1.41-1.43, n=3) | 1.24 (1.23-1.25, n=3) | — |
| nestjs-mid | completed | true | — | 590 (585-595, n=3) | 420 (415-425, n=3) | 380 (375-385, n=3) | 14 (14-14, n=3) | 9 (9-9, n=3) | 7 (7-7, n=3) | 5 (5-5, n=3) | 3 (3-3, n=3) | 2 (2-2, n=3) | 6 (6-6, n=3) | 3 (3-3, n=3) | 2 (2-2, n=3) | 14500 (14450-14550, n=3) | 11300 (11250-11350, n=3) | 10300 (10250-10350, n=3) | 1.96 (1.95-1.97, n=3) | 1.52 (1.51-1.53, n=3) | 1.34 (1.33-1.35, n=3) | — |
| ts-monorepo-large | completed | true | — | 630 (625-635, n=3) | 460 (455-465, n=3) | 420 (415-425, n=3) | 14 (14-14, n=3) | 9 (9-9, n=3) | 7 (7-7, n=3) | 5 (5-5, n=3) | 3 (3-3, n=3) | 2 (2-2, n=3) | 6 (6-6, n=3) | 3 (3-3, n=3) | 2 (2-2, n=3) | 14820 (14770-14870, n=3) | 11620 (11570-11670, n=3) | 10620 (10570-10670, n=3) | 2.06 (2.05-2.07, n=3) | 1.62 (1.61-1.63, n=3) | 1.44 (1.43-1.45, n=3) | — |
