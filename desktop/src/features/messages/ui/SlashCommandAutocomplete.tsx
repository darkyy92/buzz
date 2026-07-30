import * as React from "react";
import { Bot, Terminal } from "lucide-react";

import type {
  SlashCommandGroup,
  SlashCommandSuggestion,
} from "@/features/messages/lib/slashCommandAutocomplete";
import {
  SLASH_COMMAND_LISTBOX_ID,
  slashCommandOptionId,
} from "@/features/messages/lib/slashCommandAutocomplete";
import { cn } from "@/shared/lib/cn";
import {
  POPOVER_CUSTOM_ENTER_MOTION_CLASS,
  POPOVER_SHADOW_STYLE,
  POPOVER_SURFACE_CLASS,
} from "@/shared/ui/popoverSurface";

type SlashCommandAutocompleteProps = {
  groups: readonly SlashCommandGroup[];
  emptyMessage: string | null;
  footerMessage: string | null;
  onSelect: (suggestion: SlashCommandSuggestion) => void;
  selectedIndex: number;
};

export const SlashCommandAutocomplete = React.memo(
  function SlashCommandAutocomplete({
    groups,
    emptyMessage,
    footerMessage,
    onSelect,
    selectedIndex,
  }: SlashCommandAutocompleteProps) {
    const listRef = React.useRef<HTMLDivElement>(null);

    React.useEffect(() => {
      listRef.current
        ?.querySelector<HTMLElement>(`[data-command-index="${selectedIndex}"]`)
        ?.scrollIntoView({ block: "nearest" });
    }, [selectedIndex]);

    if (groups.length === 0 && !emptyMessage) return null;

    let commandIndex = -1;
    return (
      <div className="absolute bottom-full left-0 right-0 z-50 mb-1 px-3 sm:px-4">
        <div
          className={cn(
            "flex max-h-64 flex-col overflow-hidden rounded-xl",
            POPOVER_CUSTOM_ENTER_MOTION_CLASS,
            "origin-bottom slide-in-from-bottom-1",
            POPOVER_SURFACE_CLASS,
          )}
          data-testid="slash-command-autocomplete"
          style={POPOVER_SHADOW_STYLE}
        >
          <div
            aria-label="Agent slash commands"
            className="min-h-0 overflow-y-auto p-1"
            id={SLASH_COMMAND_LISTBOX_ID}
            ref={listRef}
            role="listbox"
          >
            {emptyMessage ? (
              <div
                className="px-3 py-2 text-sm text-muted-foreground"
                data-testid="slash-command-empty"
                role="status"
              >
                {emptyMessage}
              </div>
            ) : null}
            {groups.map((group) => (
              <fieldset
                aria-label={`Commands from ${group.agentDisplayName}`}
                className="m-0 min-w-0 border-0 p-0"
                key={group.agentPubkey}
              >
                <div className="flex items-center gap-1.5 px-3 pb-1 pt-2 text-2xs font-medium text-muted-foreground first:pt-1">
                  <Bot aria-hidden="true" className="h-3 w-3" />
                  <span className="truncate">{group.agentDisplayName}</span>
                </div>
                {group.commands.map((command) => {
                  commandIndex += 1;
                  const index = commandIndex;
                  return (
                    <button
                      className={cn(
                        "flex w-full cursor-pointer items-start gap-2 rounded-lg px-3 py-1.5 text-left text-sm",
                        index === selectedIndex
                          ? "bg-accent text-accent-foreground"
                          : "text-popover-foreground hover:bg-accent/50",
                      )}
                      data-command-index={index}
                      data-testid={`slash-command-suggestion-${group.agentPubkey}-${command.name}`}
                      id={slashCommandOptionId(index)}
                      key={`${group.agentPubkey}:${command.name}`}
                      aria-selected={index === selectedIndex}
                      onMouseDown={(event) => {
                        event.preventDefault();
                        onSelect(command);
                      }}
                      role="option"
                      tabIndex={-1}
                      type="button"
                    >
                      <Terminal
                        aria-hidden="true"
                        className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block font-medium">
                          /{command.name}
                        </span>
                        {command.description ? (
                          <span className="block truncate text-xs text-muted-foreground">
                            {command.description}
                          </span>
                        ) : null}
                      </span>
                    </button>
                  );
                })}
              </fieldset>
            ))}
          </div>
          {footerMessage ? (
            <div
              className="shrink-0 border-t border-border/50 px-3 py-2 text-xs text-muted-foreground"
              data-testid="slash-command-footer"
              role="status"
            >
              {footerMessage}
            </div>
          ) : null}
        </div>
      </div>
    );
  },
);
