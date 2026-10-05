import { useState } from "react";
import { Bookmark, RotateCcw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { ROOMS } from "@/lib/data";
import type { RoomGoal, WarmStart } from "@/lib/optimizer";
import { PRESET_BY_ID } from "@/lib/presets";

export interface Snapshot {
  id: string;
  name: string;
  at: string; // ISO date
  score: number;
  placed: number;
  house: { stage: string; enabled: string[] };
  goals: Record<string, RoomGoal>;
  appealWeight: number;
  layout: WarmStart;
  /** exact cells, so Changes can tell a moved piece from a new one (snapshots from before this field only diff by item) */
  placements?: Record<string, SnapshotPlacement[]>;
}
export interface SnapshotPlacement {
  itemId: string;
  rare: boolean;
  x: number;
  y: number;
}

/**
 * Saved layouts. A snapshot stores the room setup, goals and every placement, so restoring one brings
 * the exact house back (the optimizer starts from it and only improves it).
 */
export function SnapshotsDialog({
  snapshots,
  canSave,
  onSave,
  onRestore,
  onDelete,
}: {
  snapshots: Snapshot[];
  canSave: boolean;
  onSave: (name: string) => void;
  onRestore: (s: Snapshot) => void;
  onDelete: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const save = () => {
    const n = name.trim() || `Layout ${new Date().toLocaleDateString()}`;
    onSave(n);
    setName("");
    setOpen(false);
  };
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="h-8 gap-1.5 text-xs" title="Save this layout or bring a saved one back" data-testid="button-snapshots">
          <Bookmark className="h-3.5 w-3.5" /> Layouts
          {snapshots.length > 0 && <span className="rounded-sm bg-muted px-1 font-mono text-[11px]">{snapshots.length}</span>}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-base">Saved layouts</DialogTitle>
          <DialogDescription className="text-xs">
            A snapshot keeps the rooms, goals and every placement. Restoring one brings that exact house back, then
            the optimizer only improves on it. Snapshots sync to every device you open this planner on.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Name this layout (e.g. Before the 80s Couch)"
            className="h-9 text-sm"
            maxLength={60}
            data-testid="input-snapshot-name"
          />
          <Button type="submit" size="sm" className="h-9" disabled={!canSave} data-testid="button-snapshot-save">
            Save current
          </Button>
        </form>
        {snapshots.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">No saved layouts yet.</p>
        ) : (
          <ul className="max-h-80 divide-y divide-border overflow-y-auto rounded-md border border-border">
            {snapshots
              .slice()
              .sort((a, b) => b.at.localeCompare(a.at))
              .map((s) => (
                <li key={s.id} className="flex items-center gap-3 px-3 py-2" data-testid={`row-snapshot-${s.id}`}>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{s.name}</p>
                    <p className="truncate text-[11px] text-muted-foreground">
                      {new Date(s.at).toLocaleString()} · score {s.score.toFixed(1)} · {s.placed} pieces ·{" "}
                      {s.house.enabled
                        .map((r) => `${ROOMS[r]?.label ?? r}: ${PRESET_BY_ID[s.goals[r]?.preset ?? ""]?.label.split(":")[0] ?? "default"}`)
                        .join(", ")}
                    </p>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 gap-1 text-xs"
                    onClick={() => {
                      onRestore(s);
                      setOpen(false);
                    }}
                    data-testid={`button-snapshot-restore-${s.id}`}
                  >
                    <RotateCcw className="h-3 w-3" /> Restore
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-muted-foreground hover:text-destructive"
                    onClick={() => onDelete(s.id)}
                    aria-label={`Delete ${s.name}`}
                    data-testid={`button-snapshot-delete-${s.id}`}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </li>
              ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}
