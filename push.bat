@echo off  
set GIT_SSH_COMMAND=ssh -i C:/Users/rodri/.ssh/id_ed25519 -o IdentitiesOnly=yes  
git push origin production  
