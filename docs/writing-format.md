# Writing format

Likho reads plain text with a few markers. Anything you don't mark is written
as normal sentences.

## Your details (optional, at the very top)

```
---
name: Your Name
reg: 2501234567
section: B3
sem: Sem-III
program: B.Tech
code: CSC2103
assignment: 2
---
```

These become the header block on the first page and the name and reg number
signed at the top of every page. Leave out anything you don't want.

## Headings and questions

```
# Q1. Explain normalisation.
# (a) First normal form
```

A line starting with `# ` is written as a heading. `Q1.` labels are underlined.

## Underline and crossing out

```
**Atomicity** is violated.
~~wrong word~~ right word
```

## Lists

```
- first point
- second point
```

## Code

Put code between three backticks. Line breaks and indentation are kept.

````
```sql
SELECT name
FROM Student
WHERE cgpa > 8.5;
```
````

## Maths

Inline maths goes between `$ $`. A worked line goes on its own line between
`$$ $$`. Likho supports common LaTeX: fractions, roots, powers, subscripts,
sums, integrals, Greek letters and arrows.

```
The mean is $\bar{x} = 12.5$.

$$S.E. = \frac{\sigma}{\sqrt{n}} = \frac{2}{\sqrt{100}} = 0.2$$
```

## Tables

Write a table as a code block. Likho keeps the columns lined up.

````
```
Item   Pair            Edge
X      R2(X), W1(X)    T2 → T1
```
````

## Diagrams

Graphs, trees and B-trees are drawn by hand from a short description:

````
```figure
width: 0.42
node T1 0 0 T_1 circle
node T2 10 5 T_2 circle
arrow T1 T2 curve=0.18
arrow T2 T1 curve=0.18
text: Precedence graph
```
````

- `node <id> <x> <y> <label>`: add `circle` to ring the label, or give keys
  as `10|20 box` for a B-tree node.
- `edge <a> <b>` or `arrow <a> <b>`: add `curve=0.2` to bend it.
- `text:` is written beside the figure.

For anything else, leave a space and draw it yourself after printing:
Likho can't copy a drawing from an image.
