# Class Plant

- [TopLevel.Object](/script-api/TopLevel.Object.md)
  - [dw.garden.Plant](/script-api/dw.garden.Plant.md)

Invented base class of everything that grows in the fixture garden.

## All Known Subclasses

[Tree](/script-api/dw.garden.Tree.md)

## Constant Summary

| Constant                                                                   | Description                            |
| -------------------------------------------------------------------------- | -------------------------------------- |
| [COLOUR\_GREEN](#colour_green): [String](/script-api/TopLevel.String.md) = "leaf\_green" | The colour of a healthy leaf. |
| [KIND](#kind): [Object](/script-api/TopLevel.Object.md)                    | The kind of a plant, set by the garden. |
| [STAGE_SEED](#stage_seed): [Number](/script-api/TopLevel.Number.md) = 0    | A plant that has not sprouted yet.     |
| ~~[STAGE_WILTED](#stage_wilted): [Number](/script-api/TopLevel.Number.md) = -1~~ | A plant past saving.          |

## Property Summary

| Property                                                                                  | Description                         |
| ----------------------------------------------------------------------------------------- | ----------------------------------- |
| [DEPTH](#depth): [Number](/script-api/TopLevel.Number.md)                                 | How deep a seed is sown.            |
| [ID](#id): [String](/script-api/TopLevel.String.md) `(read-only)`                         | Returns the id of the plant.        |
| [leaves](#leaves): [Collection](/script-api/dw.util.Collection.md) `(read-only)`          | Returns the leaves of the plant.    |
| [name](#name): [String](/script-api/TopLevel.String.md)                                   | The name the gardener gave it.      |
| ~~[oldName](#oldname): [String](/script-api/TopLevel.String.md)~~ `(read-only)`           | Returns the name it had before.     |
| [count](#count): [Number](/script-api/TopLevel.Number.md) `(read-only)`                   | Returns how many plants there are.  |

## Constructor Summary

This class does not have a constructor, so you cannot create it directly.

## Method Summary

| Method                                                                                                                                         | Description                       |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| static [getCount](/script-api/dw.garden.Plant.md#getcount)()                                                                                   | Returns how many plants there are. |
| [getID](/script-api/dw.garden.Plant.md#getid)()                                                                                                | Returns the id of the plant.      |
| [getName](/script-api/dw.garden.Plant.md#getname)()                                                                                            | Returns the name of the plant.    |
| [getOldName](/script-api/dw.garden.Plant.md#getoldname)()                                                                                      | Returns the name it had before.   |
| [tag](/script-api/dw.garden.Plant.md#tagstring)([String\[\]](/script-api/TopLevel.String.md))                                                  | Hangs labels on the plant.        |
| [water](/script-api/dw.garden.Plant.md#waternumber-boolean)([Number](/script-api/TopLevel.Number.md), [Boolean](/script-api/TopLevel.Boolean.md)) | Waters the plant.             |

### Methods inherited from class Object

[toString](/script-api/TopLevel.Object.md#tostring)

## Constant Details

### COLOUR\_GREEN

- COLOUR\_GREEN: [String](/script-api/TopLevel.String.md) = "leaf\_green"
  - : The colour of a healthy leaf.

***

### KIND

- KIND: [Object](/script-api/TopLevel.Object.md)
  - : The kind of a plant, set by the garden.

***

### STAGE_SEED

- STAGE_SEED: [Number](/script-api/TopLevel.Number.md) = 0
  - : A plant that has not sprouted yet.

***

### STAGE_WILTED

- ~~STAGE_WILTED: [Number](/script-api/TopLevel.Number.md) = -1~~
  - : A plant past saving.

    **Deprecated:**
:::warning
Compost it instead.
:::

***

## Property Details

### DEPTH

- DEPTH: [Number](/script-api/TopLevel.Number.md)
  - : How deep a seed is sown.

***

### ID

- ID: [String](/script-api/TopLevel.String.md) `(read-only)`
  - : Returns the id of the plant.

***

### count

- count: [Number](/script-api/TopLevel.Number.md) `(read-only)`
  - : Returns how many plants there are.

***

### leaves

- leaves: [Collection](/script-api/dw.util.Collection.md) `(read-only)`
  - : Returns the leaves of the plant.

***

### name

- name: [String](/script-api/TopLevel.String.md)
  - : The name the gardener gave it.

***

### oldName

- ~~oldName: [String](/script-api/TopLevel.String.md)~~ `(read-only)`
  - : Returns the name it had before.

    **Deprecated:**
:::warning
Use [name](/script-api/dw.garden.Plant.md#name) instead.
:::

***

## Method Details

### getCount()

- static getCount(): [Number](/script-api/TopLevel.Number.md)
  - : Returns how many plants there are.

***

### getID()

- getID(): [String](/script-api/TopLevel.String.md)
  - : Returns the id of the plant.

***

### getName()

- getName(): [String](/script-api/TopLevel.String.md)
  - : Returns the name of the plant.

    **Returns:**

    - the name, or null when it has none.

***

### getOldName()

- getOldName(): [String](/script-api/TopLevel.String.md)
  - : Returns the name it had before.

    **Deprecated:**
:::warning
Use [getName()](/script-api/dw.garden.Plant.md#getname) instead.
:::

***

### tag(String\[])

- tag(labels: [String\[\]](/script-api/TopLevel.String.md)): void
  - : Hangs labels on the plant.

    **Parameters:**

    - labels - the labels to hang.

***

### water(Number, Boolean)

- water(litres: [Number](/script-api/TopLevel.Number.md), warm: [Boolean](/script-api/TopLevel.Boolean.md)): [Boolean](/script-api/TopLevel.Boolean.md)
  - : Waters the plant.

    **Parameters:**

    - litres - how much water to pour.
    - warm - whether the water is warm.

    **Returns:**

    - true when the plant drank it.

    **API Version:**

***
