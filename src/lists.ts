/**
 * LISTS — editing commands over prosemirror-schema-list: Enter splits an
 * item, Tab and Shift-Tab indent and outdent it (or move between table
 * cells), "- " and "1. " start a list, and the toolbar toggles one.
 */
import { chainCommands } from "prosemirror-commands"
import { InputRule, inputRules, wrappingInputRule } from "prosemirror-inputrules"
import { keymap } from "prosemirror-keymap"
import type { NodeType } from "prosemirror-model"
import { liftListItem, sinkListItem, splitListItem, wrapInList } from "prosemirror-schema-list"
import type { Command, Plugin } from "prosemirror-state"
import { goToNextCell } from "prosemirror-tables"
import { schema } from "./schema"
import { isList } from "./units"

const { bulletList, orderedList, listItem } = schema.nodes

export const listKeymap = (): Plugin =>
  keymap({
    Enter: splitListItem(listItem),
    Tab: chainCommands(goToNextCell(1), sinkListItem(listItem)),
    "Shift-Tab": chainCommands(goToNextCell(-1), liftListItem(listItem)),
  })

export const listInputRules = (): Plugin =>
  inputRules({
    rules: [
      wrappingInputRule(/^\s*([-+*])\s$/, bulletList),
      wrappingInputRule(
        /^(\d+)\.\s$/,
        orderedList,
        (m) => ({ start: +m[1] }),
        (m, node) => node.childCount + node.attrs.start === +m[1]
      ),
    ] as InputRule[],
  })

/**
 * The toolbar's list buttons: wrap the selection in a list of `type`; in a
 * list of that type already, lift it out; in the other kind, switch kinds.
 */
export function toggleList(type: NodeType): Command {
  return (state, dispatch) => {
    const { $from } = state.selection
    for (let d = $from.depth; d > 0; d--) {
      const node = $from.node(d)
      if (!isList(node)) continue
      if (node.type === type) return liftListItem(listItem)(state, dispatch)
      dispatch?.(state.tr.setNodeMarkup($from.before(d), type, type === orderedList ? { start: 1 } : null))
      return true
    }
    return wrapInList(type)(state, dispatch)
  }
}
