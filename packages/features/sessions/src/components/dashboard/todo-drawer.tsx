import { type TodoResult } from "../todo-parser.js";
import { TodoPhaseList, TodoProgressSummary } from "../transcript/todo-tool-transcript.js";
import { Button } from "../ui/button.js";
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
  getResponsiveDrawerProps,
} from "../ui/drawer.js";
import { DashboardIcon } from "./icon.js";

export interface TodoDrawerProps {
  open: boolean;
  mobile: boolean;
  todo: TodoResult | null;
  onOpenChange(open: boolean): void;
}

export function TodoDrawer({ open, mobile, todo, onOpenChange }: TodoDrawerProps) {
  return (
    <Drawer open={open} onOpenChange={onOpenChange} {...getResponsiveDrawerProps(mobile)}>
      <DrawerContent className="model-settings-sheet todo-tracker-sheet">
        <DrawerHeader className="model-settings-header todo-tracker-sheet-header">
          <div>
            <DrawerTitle>Current Todo</DrawerTitle>
            <DrawerDescription>
              Review the latest Todo progress and complete task list for this session.
            </DrawerDescription>
          </div>
          <DrawerClose
            render={
              <Button type="button" variant="ghost" size="icon" autoFocus aria-label="Close current Todo" />
            }
          >
            <DashboardIcon name="close" />
          </DrawerClose>
        </DrawerHeader>
        <div className="model-settings-body todo-tracker-sheet-body">
          {todo ? (
            <>
              <TodoProgressSummary todo={todo} />
              <TodoPhaseList todo={todo} />
            </>
          ) : null}
        </div>
      </DrawerContent>
    </Drawer>
  );
}
