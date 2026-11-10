/** A computer the farm's helpers work on. Today the one this server runs on; others join from the command line. */
export interface Machine {
  id: string;
  name: string;
  /** The server's own machine: its helpers run in the server's process. */
  here: boolean;
  /** Reachable now: the server can hire helpers on it. */
  online: boolean;
  joinedAt: number;
}

export interface FactMachineChanged {
  type: "machineChanged";
  at: number;
  machine: Machine;
}
