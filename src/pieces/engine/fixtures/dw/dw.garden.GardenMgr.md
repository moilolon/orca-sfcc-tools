# Class GardenMgr

- [TopLevel.Object](/script-api/TopLevel.Object.md)
  - [dw.garden.GardenMgr](/script-api/dw.garden.GardenMgr.md)

Invented helper that looks after every bed of the fixture garden.

**Deprecated:**

:::warning
Use [Plant](/script-api/dw.garden.Plant.md) directly instead.
:::

## Constant Summary

| Constant                                                                   | Description                    |
| -------------------------------------------------------------------------- | ------------------------------ |
| [MAX\_BEDS](#max_beds): [Number](/script-api/TopLevel.Number.md) = 12      | How many beds a garden holds.  |

## Constructor Summary

This class does not have a constructor, so you cannot create it directly.

## Method Summary

| Method                                                                                                                                                        | Description                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| static [findPlant](/script-api/dw.garden.GardenMgr.md#findplantstring)([String](/script-api/TopLevel.String.md))                                              | Finds a plant by its name.     |
| static [harvest](/script-api/dw.garden.GardenMgr.md#harvestplant-object)([Plant](/script-api/dw.garden.Plant.md), [Object...](/script-api/TopLevel.Object.md)) | Harvests a plant.              |

### Methods inherited from class Object

[toString](/script-api/TopLevel.Object.md#tostring)

## Constant Details

### MAX\_BEDS

- MAX\_BEDS: [Number](/script-api/TopLevel.Number.md) = 12
  - : How many beds a garden holds.

***

## Method Details

### findPlant(String)

- static findPlant(name: [String](/script-api/TopLevel.String.md)): [Plant](/script-api/dw.garden.Plant.md)
  - : Finds a plant by its name.

    **Parameters:**

    - name - the name to look for.

    **Returns:**

    - the plant, or null.

***

### harvest(Plant, Object...)

- static harvest(plant: [Plant](/script-api/dw.garden.Plant.md), options: [Object...](/script-api/TopLevel.Object.md)): BasketWO
  - : Harvests a plant.

***
