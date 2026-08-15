#include <errno.h>
#include <stdio.h>

int main(int argc, char **argv) {
    if (argc != 3 || argv[1] == NULL || argv[2] == NULL
        || argv[1][0] != '/' || argv[2][0] != '/') {
        fputs("OpenBot profile publication failed.\n", stderr);
        return 2;
    }
    if (renamex_np(argv[1], argv[2], RENAME_EXCL) != 0) {
        fputs("OpenBot profile publication failed.\n", stderr);
        return errno == EEXIST ? 3 : 4;
    }
    return 0;
}
