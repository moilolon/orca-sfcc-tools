# Class Tree

- [TopLevel.Object](/script-api/TopLevel.Object.md)
  - [dw.garden.Plant](/script-api/dw.garden.Plant.md)
    - [dw.garden.Tree](/script-api/dw.garden.Tree.md)

Invented plant with a trunk, which outlives the gardener.

## Property Summary

| Property                                                                    | Description                      |
| --------------------------------------------------------------------------- | -------------------------------- |
| [height](#height): [Number](/script-api/TopLevel.Number.md)                 | The height of the tree in metres. |

## Constructor Summary

| Constructor                                                                                                                       | Description                          |
| --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| [Tree](#tree)()                                                                                                                   | Plants a tree with no name.          |
| [Tree](#treestring)([String](/script-api/TopLevel.String.md))                                                                      | Plants a tree with a name.           |
| [Tree](#treestring-number)([String](/script-api/TopLevel.String.md), [Number...](/script-api/TopLevel.Number.md))                   | Plants a tree with rings already.    |

## Method Summary

| Method                                                                                                                       | Description                             |
| ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| [getName](/script-api/dw.garden.Tree.md#getname)()                                                                           | Returns the name carved in the bark.    |
| [grow](/script-api/dw.garden.Tree.md#grownumber---variant-1)([Number](/script-api/TopLevel.Number.md))                       | Makes the tree taller.                  |
| ~~[grow](/script-api/dw.garden.Tree.md#grownumber---variant-2)([Number](/script-api/TopLevel.Number.md))~~                   | Makes the tree taller the old way.      |
| static [plantAll](/script-api/dw.garden.Tree.md#plantallstring)([String...](/script-api/TopLevel.String.md))                 | Plants one tree per name.               |

### Methods inherited from class Plant

[getOldName](/script-api/dw.garden.Plant.md#getoldname), [tag](/script-api/dw.garden.Plant.md#tagstring), [water](/script-api/dw.garden.Plant.md#waternumber-boolean)

### Methods inherited from class Object

[toString](/script-api/TopLevel.Object.md#tostring)

## Property Details

### height

- height: [Number](/script-api/TopLevel.Number.md)
  - : The height of the tree in metres.

***

## Constructor Details

### Tree()

- Tree()
  - : Plants a tree with no name.

***

### Tree(String)

- Tree(name: [String](/script-api/TopLevel.String.md))
  - : Plants a tree with a name.

    **Parameters:**

    - name - what to call it.

***

### Tree(String, Number...)

- Tree(name: [String](/script-api/TopLevel.String.md), rings: [Number...](/script-api/TopLevel.Number.md))
  - : Plants a tree with rings already.

    **Parameters:**

    - name - what to call it.
    - rings - the width of each ring.

***

## Method Details

### getName()

- getName(): [String](/script-api/TopLevel.String.md)
  - : Returns the name carved in the bark.

***

### grow(Number) - Variant 1

- grow(metres: [Number](/script-api/TopLevel.Number.md)): void
  - : Makes the tree taller.

***

### grow(Number) - Variant 2

- ~~grow(centimetres: [Number](/script-api/TopLevel.Number.md)): void~~
  - : Makes the tree taller the old way.

    **Deprecated:**
:::warning
Use [grow(Number)](/script-api/dw.garden.Tree.md#grownumber---variant-1) instead.
:::

***

### plantAll(String...)

- static plantAll(names: [String...](/script-api/TopLevel.String.md)): [List](/script-api/dw.util.List.md)
  - : Plants one tree per name.

    **Parameters:**

    - names - one name per tree.

    **Returns:**

    - the trees planted.

***
